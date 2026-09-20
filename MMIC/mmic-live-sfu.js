(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) throw new Error('MMIC Live requires unsandboxed execution.');

    // ----------------------------------------------------------------------
    // PRODUCER AUDIO MIXER
    // ----------------------------------------------------------------------
    class MMICAudioMixer {
        constructor() {
            this.audioCtx = null;
            this.destination = null;
            
            // Input Track States
            this.micStream = null;
            this.micSourceNode = null;
            
            this.extStream = null;
            this.extSourceNode = null;

            // Volume Control Nodes
            this.micVolGain = null;
            this.extVolGain = null;
            this.masterVolGain = null;
            
            // TALK Mode Ducking Control Nodes
            this.micTalkGain = null; 
            this.extDuckGain = null;
            
            // Mute Control Node
            this.masterMuteGain = null;

            this.isMuted = false;
            this.isTalking = false;
            this.micEnabled = false;
        }

        init() {
            if (this.audioCtx) return;
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContext();
            this.destination = this.audioCtx.createMediaStreamDestination();

            // Create Audio Processing Graph Nodes
            this.micVolGain = this.audioCtx.createGain();
            this.extVolGain = this.audioCtx.createGain();
            this.micTalkGain = this.audioCtx.createGain();
            this.extDuckGain = this.audioCtx.createGain();
            this.masterVolGain = this.audioCtx.createGain();
            this.masterMuteGain = this.audioCtx.createGain();

            // Default Gains
            this.micTalkGain.gain.value = 0.0; // Mute microphone off-air by default
            this.extDuckGain.gain.value = 1.0; // Full volume for music/external audio off-air
            this.masterMuteGain.gain.value = 1.0; // Master output active

            // Connect Audio Routing Pipeline:
            // Mic -> MicVol -> MicTalk -\
            //                            +-> MasterVol -> MasterMute -> Destination (WebRTC)
            // Ext -> ExtVol -> ExtDuck -/
            this.micVolGain.connect(this.micTalkGain);
            this.extVolGain.connect(this.extDuckGain);
            
            this.micTalkGain.connect(this.masterVolGain);
            this.extDuckGain.connect(this.masterVolGain);
            
            this.masterVolGain.connect(this.masterMuteGain);
            this.masterMuteGain.connect(this.destination);

            // Active silent oscillator keeps WebRTC audio tracks active even when idle
            const silence = this.audioCtx.createOscillator();
            const silenceGain = this.audioCtx.createGain();
            silenceGain.gain.value = 0;
            silence.connect(silenceGain);
            silenceGain.connect(this.masterMuteGain);
            silence.start();
        }

        async enableMicrophone() {
            this.init();
            if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

            if (this.micStream && this.micStream.active && this.micSourceNode) {
                return true;
            }

            this.disableMicrophone();

            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ 
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    } 
                });
                
                this.micSourceNode = this.audioCtx.createMediaStreamSource(this.micStream);
                this.micSourceNode.connect(this.micVolGain);
                this.micEnabled = true;
                return true;
            } catch (err) {
                console.error("MMIC Live: Microphone access error:", err);
                this.micEnabled = false;
                throw new Error("MIC_PERMISSION_DENIED: " + err.message);
            }
        }

        disableMicrophone() {
            if (this.micSourceNode) {
                try { this.micSourceNode.disconnect(); } catch (e) {}
                this.micSourceNode = null;
            }
            if (this.micStream) {
                this.micStream.getTracks().forEach(track => track.stop());
                this.micStream = null;
            }
            this.micEnabled = false;
        }

        connectExternalStream(mediaStream) {
            this.init();
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

            if (this.extSourceNode) {
                try { this.extSourceNode.disconnect(); } catch (e) {}
                this.extSourceNode = null;
            }

            this.extStream = mediaStream;
            if (mediaStream && mediaStream.getAudioTracks().length > 0) {
                this.extSourceNode = this.audioCtx.createMediaStreamSource(this.extStream);
                this.extSourceNode.connect(this.extVolGain);
            }
        }

        disconnectExternalStream() {
            if (this.extSourceNode) {
                try { this.extSourceNode.disconnect(); } catch (e) {}
                this.extSourceNode = null;
            }
            this.extStream = null;
        }

        setTalkState(talking) {
            if (!this.audioCtx) return;
            this.isTalking = talking;
            const now = this.audioCtx.currentTime;
            
            this.micTalkGain.gain.setTargetAtTime(talking ? 1.0 : 0.0, now, 0.03);
            this.extDuckGain.gain.setTargetAtTime(talking ? 0.2 : 1.0, now, 0.03);
        }

        setMute(muted) {
            if (!this.audioCtx) return;
            this.isMuted = muted;
            const now = this.audioCtx.currentTime;
            this.masterMuteGain.gain.setTargetAtTime(muted ? 0.0 : 1.0, now, 0.03);
        }

        setVolume(source, vol) {
            if (!this.audioCtx) return;
            const now = this.audioCtx.currentTime;
            const clampedVol = Math.max(0, Math.min(100, vol)) / 100.0;
            
            if (source === 'MASTER') this.masterVolGain.gain.setTargetAtTime(clampedVol, now, 0.03);
            else if (source === 'MIC') this.micVolGain.gain.setTargetAtTime(clampedVol, now, 0.03);
            else if (source === 'MUSIC') this.extVolGain.gain.setTargetAtTime(clampedVol, now, 0.03);
        }

        getMasterStream() {
            this.init();
            return this.destination.stream;
        }
    }

    // ----------------------------------------------------------------------
    // MMIC LIVE SCRATCH EXTENSION
    // ----------------------------------------------------------------------
    class MMICLiveExtension {
        constructor() {
            this.mixer = new MMICAudioMixer();
            this.ws = null;
            this.pc = null;
            this.pendingCandidates = [];
            this.dataChannel = null;
            this.connectionState = 'OFFLINE';
            this.broadcasterPresent = false;
            this.lastError = '';
            this.role = 'NONE';
            this.ping = 0;
            this.pingInterval = null;

            // Injected Audio Controller Properties
            this.broadcastAudioElement = null;
            this.isAudioPlaying = false;

            // Listener Local Output
            this.incomingAudioElement = new Audio();
            this.incomingAudioElement.autoplay = false;

            // Global JS Interface for MediaCentre/MENGINE Integration
            window.MMICLive = {
                setExternalStream: (stream) => this.mixer.connectExternalStream(stream),
                stopExternalStream: () => this.stopBroadcastAudio()
            };
        }

        getInfo() {
            return {
                id: 'mmicLiveSFU',
                name: 'MMIC Live',
                color1: '#D32F2F',
                color2: '#B71C1C',
                blocks: [
                    // Connection Commands
                    { opcode: 'connectToServer', blockType: Scratch.BlockType.COMMAND, text: 'connect to live server [URL]', arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'ws://localhost:8080' } } },
                    { opcode: 'initBroadcaster', blockType: Scratch.BlockType.COMMAND, text: 'start broadcasting' },
                    { opcode: 'initListener', blockType: Scratch.BlockType.COMMAND, text: 'start listening' },
                    { opcode: 'disconnect', blockType: Scratch.BlockType.COMMAND, text: 'disconnect' },
                    '---',
                    // Producer Microphone & Mixer Controls
                    { opcode: 'enableMicrophone', blockType: Scratch.BlockType.COMMAND, text: 'enable producer microphone' },
                    { opcode: 'setTalkButton', blockType: Scratch.BlockType.COMMAND, text: 'set TALK state [STATE]', arguments: { STATE: { type: Scratch.ArgumentType.STRING, menu: 'onOff' } } },
                    { opcode: 'setProducerVolume', blockType: Scratch.BlockType.COMMAND, text: 'set producer [SOURCE] volume to [VOL] %', arguments: { SOURCE: { type: Scratch.ArgumentType.STRING, menu: 'audioSources' }, VOL: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 } } },
                    { opcode: 'setProducerMute', blockType: Scratch.BlockType.COMMAND, text: 'set broadcast mute [STATE]', arguments: { STATE: { type: Scratch.ArgumentType.STRING, menu: 'onOff' } } },
                    { opcode: 'getProducerMute', blockType: Scratch.BlockType.REPORTER, text: 'is broadcast muted?' },
                    '---',
                    // Injected Audio Broadcasting Commands (URL / Data:URL)
                    { opcode: 'broadcastAudioFromURL', blockType: Scratch.BlockType.COMMAND, text: 'broadcast audio from URL [URL]', arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' } } },
                    { opcode: 'stopBroadcastAudio', blockType: Scratch.BlockType.COMMAND, text: 'stop broadcast audio' },
                    { opcode: 'setBroadcastAudioVolume', blockType: Scratch.BlockType.COMMAND, text: 'set broadcast audio volume to [VOL] %', arguments: { VOL: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 } } },
                    { opcode: 'isBroadcastAudioPlaying', blockType: Scratch.BlockType.BOOLEAN, text: 'broadcast audio playing?' },
                    '---',
                    // Listener Audio Controls
                    { opcode: 'startListenerOutput', blockType: Scratch.BlockType.COMMAND, text: 'start listener live audio output' },
                    { opcode: 'setListenerVolume', blockType: Scratch.BlockType.COMMAND, text: 'set listener volume to [VOL] %', arguments: { VOL: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 } } },
                    { opcode: 'setListenerMute', blockType: Scratch.BlockType.COMMAND, text: 'set listener mute [STATE]', arguments: { STATE: { type: Scratch.ArgumentType.STRING, menu: 'onOff' } } },
                    '---',
                    // Status & Diagnostics Reporters
                    { opcode: 'isBroadcasterConnected', blockType: Scratch.BlockType.BOOLEAN, text: 'broadcaster connected?' },
                    { opcode: 'getConnectionState', blockType: Scratch.BlockType.REPORTER, text: 'connection state' },
                    { opcode: 'getPing', blockType: Scratch.BlockType.REPORTER, text: 'server ping (ms)' },
                    { opcode: 'getLastError', blockType: Scratch.BlockType.REPORTER, text: 'last error' }
                ],
                menus: {
                    onOff: { acceptReporters: true, items: ['ON', 'OFF'] },
                    audioSources: { acceptReporters: false, items: ['MASTER', 'MIC', 'MUSIC'] }
                }
            };
        }

        // --- CONNECTION API ---
        connectToServer(args) {
            this.lastError = '';
            this._changeState('CONNECTING');
            try {
                this.ws = new WebSocket(args.URL);
            } catch (err) {
                this.lastError = 'INVALID_URL: ' + err.message;
                this._changeState('FAILED');
                return;
            }

            this.ws.onmessage = (event) => this._handleSignalingMessage(JSON.parse(event.data));
            this.ws.onerror = (err) => {
                this.lastError = 'WEBSOCKET_ERROR';
            };
            this.ws.onclose = () => {
                this.broadcasterPresent = false;
                this._changeState('DISCONNECTED');
            };
            this.ws.onopen = () => {
                this._changeState('CONNECTED');
                this.pingInterval = setInterval(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'ping', time: Date.now() }));
                    }
                }, 2000);
            };
        }

        async initBroadcaster() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.lastError = 'NOT_CONNECTED_TO_SERVER';
                return;
            }
            this.role = 'BROADCASTER';
            this._setupWebRTC();
            this.ws.send(JSON.stringify({ type: 'join', role: 'broadcaster' }));

            const stream = this.mixer.getMasterStream();
            this.pc.addTrack(stream.getAudioTracks()[0], stream);

            this.dataChannel = this.pc.createDataChannel('mmic_control');
            this._createAndSendOffer();
        }

        async initListener() {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.lastError = 'NOT_CONNECTED_TO_SERVER';
                return;
            }
            this.role = 'LISTENER';
            this._setupWebRTC();
            this.ws.send(JSON.stringify({ type: 'join', role: 'listener' }));

            this.pc.ontrack = (event) => {
                this.incomingAudioElement.srcObject = event.streams[0];
                this._changeState('LIVE');
            };

            this.pc.ondatachannel = (event) => {
                this.dataChannel = event.channel;
            };

            this.pc.addTransceiver('audio', { direction: 'recvonly' });
            this._createAndSendOffer();
        }

        disconnect() {
            this.stopBroadcastAudio();
            this.pendingCandidates = [];
            this.broadcasterPresent = false;
            if (this.pc) {
                try { this.pc.close(); } catch(e){}
                this.pc = null;
            }
            if (this.ws) {
                try { this.ws.close(); } catch(e){}
                this.ws = null;
            }
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }
            this.incomingAudioElement.pause();
            this.incomingAudioElement.srcObject = null;
            this.mixer.disableMicrophone();
            this._changeState('DISCONNECTED');
        }

        // --- PRODUCER API ---
        async enableMicrophone() {
            try {
                await this.mixer.enableMicrophone();
            } catch (err) {
                this.lastError = err.message;
            }
        }

        setTalkButton(args) {
            this.mixer.setTalkState(args.STATE === 'ON');
        }

        setProducerVolume(args) {
            this.mixer.setVolume(args.SOURCE, args.VOL);
        }

        setProducerMute(args) {
            this.mixer.setMute(args.STATE === 'ON');
        }

        getProducerMute() {
            return this.mixer.isMuted ? 'ON' : 'OFF';
        }

        // --- INJECTED AUDIO BROADCASTING API ---
        async broadcastAudioFromURL(args) {
            const url = args.URL;
            if (!url) return;

            this.stopBroadcastAudio();

            try {
                const audio = new Audio();
                
                if (!url.startsWith('data:')) {
                    audio.crossOrigin = "anonymous";
                }

                audio.src = url;
                this.broadcastAudioElement = audio;

                audio.onended = () => {
                    this.isAudioPlaying = false;
                    this.mixer.disconnectExternalStream();
                };

                audio.onerror = (e) => {
                    console.error("MMIC Live: Audio stream playback error", e);
                    this.lastError = 'AUDIO_URL_LOAD_FAILED';
                    this.stopBroadcastAudio();
                };

                await audio.play();
                this.isAudioPlaying = true;

                let stream = null;
                if (typeof audio.captureStream === 'function') {
                    stream = audio.captureStream();
                } else if (typeof audio.mozCaptureStream === 'function') {
                    stream = audio.mozCaptureStream();
                } else {
                    throw new Error('CAPTURE_STREAM_UNSUPPORTED');
                }

                this.mixer.connectExternalStream(stream);

            } catch (err) {
                console.error("MMIC Live: Broadcast Audio Injection failed", err);
                this.lastError = 'BROADCAST_AUDIO_ERROR: ' + err.message;
                this.stopBroadcastAudio();
            }
        }

        stopBroadcastAudio() {
            if (this.broadcastAudioElement) {
                try {
                    this.broadcastAudioElement.pause();
                    this.broadcastAudioElement.src = '';
                    this.broadcastAudioElement.load();
                } catch (e) {}
                this.broadcastAudioElement = null;
            }
            this.isAudioPlaying = false;
            this.mixer.disconnectExternalStream();
        }

        setBroadcastAudioVolume(args) {
            this.mixer.setVolume('MUSIC', args.VOL);
        }

        isBroadcastAudioPlaying() {
            return this.isAudioPlaying;
        }

        // --- LISTENER API ---
        startListenerOutput() {
            if (this.incomingAudioElement.srcObject) {
                this.incomingAudioElement.play().catch(e => {
                    console.warn("Live playback blocked by browser autoplay rules.", e);
                    this.lastError = 'AUTOPLAY_BLOCKED';
                });
            }
        }

        setListenerVolume(args) {
            this.incomingAudioElement.volume = Math.max(0, Math.min(100, args.VOL)) / 100.0;
        }

        setListenerMute(args) {
            this.incomingAudioElement.muted = (args.STATE === 'ON');
        }

        // --- DIAGNOSTICS & REPORTERS ---
        isBroadcasterConnected() {
            return this.broadcasterPresent;
        }

        getConnectionState() {
            return this.connectionState;
        }

        getPing() {
            return this.ping;
        }

        getLastError() {
            return this.lastError;
        }

        // --- INTERNAL WEBRTC & SIGNALING ---
        _setupWebRTC() {
            this.pendingCandidates = [];
            this.pc = new RTCPeerConnection();
            
            this.pc.onicecandidate = (event) => {
                if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
                }
            };

            this.pc.onconnectionstatechange = () => {
                if (this.pc.connectionState === 'failed') {
                    this.lastError = 'WEBRTC_CONNECTION_FAILED';
                    this._changeState('FAILED');
                } else if (this.pc.connectionState === 'connected') {
                    this._changeState('LIVE');
                }
            };
        }

        async _createAndSendOffer() {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            this.ws.send(JSON.stringify({ type: 'offer', sdp: this.pc.localDescription }));
        }

        async _handleSignalingMessage(data) {
            try {
                if (data.type === 'broadcaster_status') {
                    this.broadcasterPresent = !!data.connected;
                } else if (data.type === 'answer') {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                    
                    while (this.pendingCandidates.length > 0) {
                        const candidate = this.pendingCandidates.shift();
                        await this.pc.addIceCandidate(candidate);
                    }
                } else if (data.type === 'offer') {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);
                    this.ws.send(JSON.stringify({ type: 'answer', sdp: this.pc.localDescription }));

                    while (this.pendingCandidates.length > 0) {
                        const candidate = this.pendingCandidates.shift();
                        await this.pc.addIceCandidate(candidate);
                    }
                } else if (data.type === 'ice') {
                    if (data.candidate) {
                        const candidate = new RTCIceCandidate(data.candidate);
                        if (!this.pc || !this.pc.remoteDescription || !this.pc.remoteDescription.type) {
                            this.pendingCandidates.push(candidate);
                        } else {
                            await this.pc.addIceCandidate(candidate);
                        }
                    }
                } else if (data.type === 'pong') {
                    this.ping = Date.now() - data.time;
                }
            } catch (err) {
                console.error("MMIC Live: WebRTC negotiation error", err);
                this.lastError = 'SIGNALING_ERROR: ' + err.message;
            }
        }

        _changeState(state) {
            this.connectionState = state;
            console.log("MMIC Live State:", state);
        }
    }

    Scratch.extensions.register(new MMICLiveExtension());
})(Scratch);