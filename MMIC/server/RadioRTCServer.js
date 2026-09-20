// MMIC Live SFU Server - Milestone 2 (Ping/Pong Support)
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('werift');
const { WebSocketServer } = require('ws');

const port = 8080;
const wss = new WebSocketServer({ port });

let broadcasterTrack = null;
const listeners = new Set(); // Stores listener peer connections and channels
let isBroadcasterConnected = false; // Tracks broadcaster status for clients

console.log(`MMIC Live SFU Server running on ws://localhost:${port}`);

// Broadcasts the current broadcaster status to all active WebSocket clients
function broadcastStatus() {
    const statusMsg = JSON.stringify({ type: 'broadcaster_status', connected: isBroadcasterConnected });
    wss.clients.forEach((client) => {
        // Ready state 1 means OPEN
        if (client.readyState === 1) {
            client.send(statusMsg);
        }
    });
}

wss.on('connection', (ws) => {
    // Immediately tell the new client if a broadcaster is already active
    ws.send(JSON.stringify({ type: 'broadcaster_status', connected: isBroadcasterConnected }));

    let role = null;
    const pc = new RTCPeerConnection();
    let dataChannel = null;

    // 1. Gather ICE Candidates from Server and send to Browser
    pc.onIceCandidate.subscribe((candidate) => {
        if (candidate) {
            ws.send(JSON.stringify({ type: 'ice', candidate: candidate.toJSON() }));
        }
    });

    // 2. Handle Incoming Master Audio Track from Broadcaster
    pc.onTrack.subscribe((track) => {
        console.log("🎤 [AUDIO] Received Master Track from Broadcaster");
        broadcasterTrack = track;

        // Forward master track to any listeners that joined before the stream started
        listeners.forEach((listener) => {
            try {
                listener.pc.addTrack(broadcasterTrack);
            } catch (err) {
                console.warn("Could not attach track to existing listener:", err.message);
            }
        });
    });

    // 3. Handle DataChannel from Broadcaster (Metadata / Control Signals)
    pc.onDataChannel.subscribe((dc) => {
        console.log("📡 [DATA] Broadcaster Control Channel opened");
        dc.onMessage.subscribe((msg) => {
            listeners.forEach((listener) => {
                if (listener.dc && listener.dc.readyState === 'open') {
                    listener.dc.send(msg);
                }
            });
        });
    });

    // 4. Handle WebSocket Signaling
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Handle Ping Measurement
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', time: data.time }));
                return;
            }

            if (data.type === 'join') {
                role = data.role;
                console.log(`[JOIN] Client connected as: ${role}`);

                if (role === 'listener') {
                    dataChannel = pc.createDataChannel('mmic_control');
                    listeners.add({ ws, pc, dc: dataChannel });

                    if (broadcasterTrack) {
                        try {
                            pc.addTrack(broadcasterTrack);
                        } catch (e) {
                            console.warn("Error attaching track to new listener:", e.message);
                        }
                    }
                } else if (role === 'broadcaster') {
                    // Update global state and notify all clients
                    isBroadcasterConnected = true;
                    broadcastStatus();
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
        } else if (role === 'broadcaster') {
            broadcasterTrack = null;
            // Update global state and notify all clients that broadcaster left
            isBroadcasterConnected = false;
            broadcastStatus();
        }
    });
});