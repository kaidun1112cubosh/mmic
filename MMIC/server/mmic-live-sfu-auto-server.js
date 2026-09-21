// MMIC Live SFU Server - Autonomous Radio Edition
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStreamTrack } = require('werift');
const { WebSocketServer } = require('ws');
const dgram = require('dgram');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const port = 8080;
const rtpPort = 4000; // Local UDP port to receive audio from FFmpeg
const wss = new WebSocketServer({ port });

const listeners = new Set(); // Stores listener peer connections and channels

// The server IS the broadcaster now, so this is always true
const isBroadcasterConnected = true; 

// 1. Create the persistent Master Audio Track for the server
const broadcasterTrack = new MediaStreamTrack({ kind: "audio" });

// 2. Set up a local UDP server to ingest RTP packets from FFmpeg and feed them to the WebRTC track
const udpServer = dgram.createSocket('udp4');
udpServer.bind(rtpPort, '127.0.0.1');
udpServer.on('message', (msg) => {
    try {
        broadcasterTrack.writeRtp(msg);
    } catch (e) {
        // Ignore occasional RTP sequence errors during track transitions
    }
});

console.log(`MMIC Live Autonomous Server running on ws://localhost:${port}`);
console.log(`Internal RTP ingest running on UDP port ${rtpPort}`);

// --- AUDIO PLAYBACK ENGINE ---
const audioDir = path.join(__dirname, 'audio'); // Create an "audio" folder next to this script
let playlist = [];
let currentTrackIndex = 0;

// Recursively scan a directory for MP3 and WAV files
function scanFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir); // Auto-create folder if it doesn't exist
    }
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            scanFiles(fullPath, fileList);
        } else {
            const ext = path.extname(file).toLowerCase();
            if (ext === '.mp3' || ext === '.wav') {
                fileList.push(fullPath);
            }
        }
    }
    return fileList;
}

function startRadio() {
    playlist = scanFiles(audioDir);
    if (playlist.length === 0) {
        console.warn(`[WARN] No .mp3 or .wav files found in ${audioDir}. Drop some files in and restart!`);
        return;
    }
    console.log(`[SYSTEM] Found ${playlist.length} audio tracks. Beginning broadcast loop...`);
    playNextTrack();
}

function playNextTrack() {
    if (playlist.length === 0) return;
    
    const trackPath = playlist[currentTrackIndex];
    console.log(`🎶 [PLAYING] ${path.basename(trackPath)}`);
    
    // Spawn FFmpeg to stream the file as WebRTC-compatible Opus RTP packets
    const ffmpeg = spawn('ffmpeg', [
        '-re',                  // Read input at native frame rate (realtime)
        '-i', trackPath,        // Input file
        '-map', '0:a:0',        // Take the first audio stream
        '-c:a', 'libopus',      // Encode to Opus (Required for WebRTC)
        '-b:a', '128k',         // Bitrate
        '-ac', '2',             // Stereo
        '-ar', '48000',         // 48kHz sample rate
        '-f', 'rtp',            // Output format RTP
        `rtp://127.0.0.1:${rtpPort}` // Route to our Node UDP socket
    ]);

    // When the song ends naturally (or crashes), move to the next track
    ffmpeg.on('close', () => {
        currentTrackIndex = (currentTrackIndex + 1) % playlist.length;
        playNextTrack(); // Loop forever
    });

    // Suppress verbose FFmpeg output to keep the terminal clean
    ffmpeg.stderr.on('data', () => {}); 
}

// Start the continuous playback loop
startRadio();


// --- WEBRTC & SIGNALING SERVER ---
wss.on('connection', (ws) => {
    // Immediately tell the new client that the broadcaster is active[cite: 3]
    ws.send(JSON.stringify({ type: 'broadcaster_status', connected: isBroadcasterConnected }));

    let role = null;
    const pc = new RTCPeerConnection();
    let dataChannel = null;

    // Gather ICE Candidates from Server and send to Browser[cite: 3]
    pc.onIceCandidate.subscribe((candidate) => {
        if (candidate) {
            ws.send(JSON.stringify({ type: 'ice', candidate: candidate.toJSON() }));
        }
    });

    // Handle WebSocket Signaling[cite: 3]
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Handle Ping Measurement[cite: 3]
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', time: data.time }));
                return;
            }

            if (data.type === 'join') {
                role = data.role;
                console.log(`[JOIN] Client connected as: ${role}`);

                // We only care about listeners now; the server is the broadcaster[cite: 3]
                if (role === 'listener') {
                    dataChannel = pc.createDataChannel('mmic_control');
                    listeners.add({ ws, pc, dc: dataChannel });

                    // Instantly attach the server's continuous radio track
                    try {
                        pc.addTrack(broadcasterTrack);
                    } catch (e) {
                        console.warn("Error attaching track to new listener:", e.message);
                    }
                }
            } 
            else if (data.type === 'offer') {
                const sdpObj = typeof data.sdp === 'string' ? JSON.parse(data.sdp) : data.sdp;
                const remoteDesc = new RTCSessionDescription(sdpObj.sdp, sdpObj.type);
                await pc.setRemoteDescription(remoteDesc);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
            } 
            else if (data.type === 'ice') {
                if (data.candidate && data.candidate.candidate) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                }
            }
        } catch (err) {
            console.error("Error processing message:", err);
        }
    });

    ws.on('close', () => {
        console.log(`[LEAVE] ${role || 'Client'} disconnected.`);
        try { pc.close(); } catch (e) {}

        if (role === 'listener') {
            listeners.forEach((listener) => {
                if (listener.ws === ws) listeners.delete(listener);
            });
        }
    });
});