(function (Scratch) {
    'use strict';

    // MMIC V-Sync Prototype v0.4.3 — MENGINE crash-detection sensors and graphics failsafe.

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('MMIC V-Sync must be loaded as an unsandboxed extension.');
    }

    const vm = Scratch.vm;
    if (!vm || !vm.runtime) {
        throw new Error('MMIC V-Sync could not access the PenguinMod VM.');
    }

    class MMICVSyncOptimized {
        constructor() {
            this.runtime = vm.runtime;
            this.enabled = false;
            this.renderer = null;
            this.originalDraw = null;
            this.wrappedDraw = null;
            this.pendingFrame = null;
            this.needsDraw = false;
            this.lastError = '';

            this.canvas = null;
            this.gl = null;
            this.canvasWidth = null;
            this.canvasHeight = null;
            this.onContextLost = null;
            this.onContextRestored = null;
            this.contextState = 'Not checked';
            this.lastContextEvent = 'None';

            this.resizeRedraws = 0;
            this.drawRequests = 0;
            this.coalescedRequests = 0;
            this.renderedFrames = 0;
            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.sampleRequests = 0;
            this.sampleCoalesced = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;
            this.measuredRequestRate = 0;
            this.measuredCoalescedRate = 0;

            // Fixed-size ring buffer: no array shifting or per-frame allocation.
            // Samples are added only when an actual dirty render is presented.
            this.maxFrameHistory = 120;
            this.frameIntervals = new Float64Array(this.maxFrameHistory);
            this.frameIntervalCount = 0;
            this.frameIntervalIndex = 0;
            this.lastFrameTimestamp = 0;

            // MENGINE crash-detector interface. Faults are event-driven and latched
            // until acknowledged; no setInterval polling is added to the hot path.
            this.faultSequence = 0;
            this.acknowledgedFaultSequence = 0;
            this.faultHistory = [];
            this.maxFaultHistory = 16;
            this.lastFault = null;
            this.safetyLatched = false;
            this.safetyReason = '';
            this.lastDrawDurationMs = 0;
            this.maxDrawDurationMs = 0;
            this.lastRequestToRafMs = 0;
            this.maxRequestToRafMs = 0;
            this.lastDrawRequestAt = 0;
            this.slowDrawCount = 0;
            this.consecutiveSlowDraws = 0;
            this.slowDrawWarningIssued = false;
            this.stallCount = 0;
            this.performanceFaultTimes = Object.create(null);
            this.drawSlowThresholdMs = 100;
            this.rafDelayWarningMs = 1000;

            this.rendererExceptionDetected = false;

            this.onStepEnd = () => { this.sampleSteps++; };
            this.onVisibilityChange = () => {
                if (document.hidden) {
                    // RAF is normally paused in hidden tabs. Cancel our pending request
                    // and reset request timing so background time is not misreported as a stall.
                    this._cancelPendingFrame();
                    this.lastDrawRequestAt = 0;
                    this.lastFrameTimestamp = 0;
                    return;
                }
                if (this.enabled && !this.safetyLatched && this.renderer && this.renderer.dirty) {
                    this.needsDraw = true;
                    this.lastDrawRequestAt = performance.now();
                    this._scheduleDraw();
                }
            };
            this.onRuntimeDisposed = () => {
                this.enabled = false;
                this._cancelPendingFrame();
                this.needsDraw = false;
                // Runtime disposal ends this extension instance's renderer ownership.
                // Restore the function reference without making one last draw call.
                this._restoreRenderer();
            };

            this.runtime.on('RUNTIME_STEP_END', this.onStepEnd);
            this.runtime.on('RUNTIME_DISPOSED', this.onRuntimeDisposed);
            document.addEventListener('visibilitychange', this.onVisibilityChange);
        }

        getInfo() {
            return {
                id: 'mmicvsyncoptimized',
                name: 'MMIC V-Sync TEST v0.4.3 Crash Detection Sensors',
                color1: '#2878B8',
                color2: '#1F6399',
                color3: '#174D78',
                blocks: [
                    { opcode: 'enableVSync', blockType: Scratch.BlockType.COMMAND, text: 'enable display-synchronized rendering' },
                    { opcode: 'disableVSync', blockType: Scratch.BlockType.COMMAND, text: 'disable display-synchronized rendering' },
                    { opcode: 'isEnabled', blockType: Scratch.BlockType.BOOLEAN, text: 'display-synchronized rendering enabled?' },
                    { opcode: 'getStepRate', blockType: Scratch.BlockType.REPORTER, text: 'measured VM steps per second' },
                    { opcode: 'getRenderRate', blockType: Scratch.BlockType.REPORTER, text: 'measured rendered frames per second' },
                    { opcode: 'getRequestRate', blockType: Scratch.BlockType.REPORTER, text: 'renderer draw requests per second' },
                    { opcode: 'getCoalescedRate', blockType: Scratch.BlockType.REPORTER, text: 'coalesced draw requests per second' },
                    { opcode: 'getFramePacing', blockType: Scratch.BlockType.REPORTER, text: 'recent frame pacing details' },
                    { opcode: 'getPipelineStats', blockType: Scratch.BlockType.REPORTER, text: 'draw pipeline statistics' },
                    { opcode: 'getContextStatus', blockType: Scratch.BlockType.REPORTER, text: 'WebGL context status' },
                    { opcode: 'getLastContextEvent', blockType: Scratch.BlockType.REPORTER, text: 'last WebGL context event' },
                    { opcode: 'getResizeRedraws', blockType: Scratch.BlockType.REPORTER, text: 'immediate resize redraws' },
                    { opcode: 'getHQEnabled', blockType: Scratch.BlockType.BOOLEAN, text: 'TurboWarp HQ render enabled?' },
                    { opcode: 'getPenSkinDetected', blockType: Scratch.BlockType.BOOLEAN, text: 'renderer PenSkin exists?' },
                    { opcode: 'getPenDetails', blockType: Scratch.BlockType.REPORTER, text: 'HQ Pen renderer details' },
                    { opcode: 'getStatus', blockType: Scratch.BlockType.REPORTER, text: 'V-Sync status' },

                    // MENGINE crash-detector reporters and acknowledgement command.
                    { opcode: 'getGraphicsFaultPending', blockType: Scratch.BlockType.BOOLEAN, text: 'graphics fault pending?' },
                    { opcode: 'getGraphicsFaultLevel', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault severity level' },
                    { opcode: 'getGraphicsFaultLevelName', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault severity name' },
                    { opcode: 'getGraphicsFaultCode', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault code' },
                    { opcode: 'getGraphicsFaultMessage', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault message' },
                    { opcode: 'getGraphicsFaultSequence', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault sequence number' },
                    { opcode: 'getGraphicsFaultCount', blockType: Scratch.BlockType.REPORTER, text: 'unacknowledged graphics fault count' },
                    { opcode: 'getGraphicsFaultJSON', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault details JSON' },
                    { opcode: 'getGraphicsFaultHistoryJSON', blockType: Scratch.BlockType.REPORTER, text: 'graphics fault history JSON' },
                    { opcode: 'acknowledgeGraphicsFaults', blockType: Scratch.BlockType.COMMAND, text: 'acknowledge current graphics faults' },
                    { opcode: 'acknowledgeGraphicsFaultsThrough', blockType: Scratch.BlockType.COMMAND, text: 'acknowledge graphics faults through sequence [SEQUENCE]', arguments: { SEQUENCE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 } } },
                    { opcode: 'getWebGLContextLost', blockType: Scratch.BlockType.BOOLEAN, text: 'WebGL context lost?' },
                    { opcode: 'getRendererExceptionDetected', blockType: Scratch.BlockType.BOOLEAN, text: 'renderer exception detected?' },
                    { opcode: 'getGraphicsSafetyLatched', blockType: Scratch.BlockType.BOOLEAN, text: 'graphics failsafe active?' },
                    { opcode: 'getGraphicsHealthState', blockType: Scratch.BlockType.REPORTER, text: 'graphics health state' },
                    { opcode: 'getLastDrawDuration', blockType: Scratch.BlockType.REPORTER, text: 'last renderer draw duration ms' },
                    { opcode: 'getMaxDrawDuration', blockType: Scratch.BlockType.REPORTER, text: 'maximum renderer draw duration ms' },
                    { opcode: 'getLastRequestToRafDelay', blockType: Scratch.BlockType.REPORTER, text: 'last draw request to RAF delay ms' },
                    { opcode: 'getMaxRequestToRafDelay', blockType: Scratch.BlockType.REPORTER, text: 'maximum draw request to RAF delay ms' },
                    { opcode: 'getSlowDrawCount', blockType: Scratch.BlockType.REPORTER, text: 'slow renderer draw count' },
                    { opcode: 'getStallCount', blockType: Scratch.BlockType.REPORTER, text: 'visible-tab rendering stall count' },
                    { opcode: 'getRendererAttached', blockType: Scratch.BlockType.BOOLEAN, text: 'V-Sync renderer attached?' },
                    { opcode: 'getPageCrashDetectionCapability', blockType: Scratch.BlockType.REPORTER, text: 'in-page crash detection capability' },
                    { opcode: 'releaseGraphicsSafetyLatch', blockType: Scratch.BlockType.COMMAND, text: 'release graphics failsafe after MENGINE recovery' }
                ]
            };
        }

        _getCanvas(renderer) {
            if (!renderer) return null;
            return renderer.canvas || (renderer.gl && renderer.gl.canvas) ||
                (renderer._gl && renderer._gl.canvas) || null;
        }

        _getGL(renderer) {
            if (!renderer) return null;
            return renderer.gl || renderer._gl || null;
        }

        _getPenSkin(renderer) {
            if (!renderer || !Number.isInteger(renderer._penSkinId) || renderer._penSkinId < 0) {
                return { id: null, skin: null };
            }
            const skin = renderer._allSkins && renderer._allSkins[renderer._penSkinId];
            return { id: renderer._penSkinId, skin: skin || null };
        }

        _describePenSkin() {
            const renderer = this.renderer || this.runtime.renderer;
            if (!renderer) return 'Renderer unavailable';
            const found = this._getPenSkin(renderer);
            if (!found.skin) {
                return `No PenSkin at _penSkinId=${String(renderer._penSkinId)}; HQ render=${String(renderer.useHighQualityRender)}`;
            }
            const skin = found.skin;
            const size = Array.isArray(skin._size) ? skin._size.join('x') : 'unknown';
            const native = Array.isArray(skin._nativeSize) ? skin._nativeSize.join('x') : 'unknown';
            const quality = Number.isFinite(skin.renderQuality) ? skin.renderQuality : 'unknown';
            const texture = skin._texture ? 'present' : 'not exposed';
            return `HQ render=${String(renderer.useHighQualityRender)}; PenSkin=${skin.constructor && skin.constructor.name || 'unknown'}; id=${found.id}; renderQuality=${quality}; penBuffer=${size}; nativeSize=${native}; texture=${texture}`;
        }

        _removeContextListeners() {
            if (this.canvas && this.onContextLost) this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
            if (this.canvas && this.onContextRestored) this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
            if (this.canvas && this.onContextCreationError) this.canvas.removeEventListener('webglcontextcreationerror', this.onContextCreationError);
            this.canvas = null;
            this.gl = null;
            this.onContextLost = null;
            this.onContextRestored = null;
            this.onContextCreationError = null;
        }

        _attachContextListeners(renderer) {
            this._removeContextListeners();
            this.canvas = this._getCanvas(renderer);
            this.gl = this._getGL(renderer);
            if (!this.canvas) {
                this.contextState = 'Canvas unavailable';
                return;
            }
            this.canvasWidth = this.canvas.width;
            this.canvasHeight = this.canvas.height;
            this.onContextLost = (event) => {
                // preventDefault permits the browser's WebGL restoration procedure.
                // V-Sync itself remains latched off until MENGINE validates recovery.
                try { if (event && typeof event.preventDefault === 'function') event.preventDefault(); } catch (_) {}
                this.contextState = 'LOST';
                this.lastContextEvent = 'webglcontextlost';
                this.lastError = 'The browser reported that the WebGL context was lost.';
                this._enterGraphicsSafety('WEBGL_CONTEXT_LOST', 6, this.lastError, {
                    statusMessage: event && typeof event.statusMessage === 'string' ? event.statusMessage : ''
                });
                console.error('[MMIC V-Sync v0.4.3] WEBGL_CONTEXT_LOST; V-Sync draw scheduling has been stopped.', event);
            };
            this.onContextRestored = () => {
                this.contextState = 'Restored event received; renderer recovery not yet validated';
                this.lastContextEvent = 'webglcontextrestored';
                // Do not automatically resume. MENGINE must rebuild/validate renderer resources.
                console.warn('[MMIC V-Sync v0.4.3] WebGL context restored; failsafe remains latched pending MENGINE validation.');
            };
            this.onContextCreationError = (event) => {
                const statusMessage = event && typeof event.statusMessage === 'string' ? event.statusMessage : '';
                this.contextState = 'Creation failed';
                this.lastContextEvent = 'webglcontextcreationerror';
                this._enterGraphicsSafety('WEBGL_CONTEXT_CREATION_FAILED', 5,
                    'The browser reported a WebGL context creation failure.', { statusMessage });
            };
            this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
            this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
            this.canvas.addEventListener('webglcontextcreationerror', this.onContextCreationError, false);
            this._updateContextStatus();
        }

        _recordGraphicsFault(code, level, message, details = {}) {
            const event = {
                sequence: ++this.faultSequence,
                code: String(code),
                level: Math.max(0, Math.min(8, Math.trunc(Number(level) || 0))),
                message: String(message || code),
                timeMs: Number(performance.now().toFixed(2)),
                details: details && typeof details === 'object' ? details : {}
            };
            this.lastFault = event;
            this.faultHistory.push(event);
            if (this.faultHistory.length > this.maxFaultHistory) this.faultHistory.shift();
            return event;
        }

        _enterGraphicsSafety(code, level, message, details = {}) {
            // Avoid repeatedly recording the same terminal fault while draw calls
            // continue arriving from the VM. Keep the renderer wrapper installed as
            // a guard so it cannot call into a known-failed WebGL renderer.
            if (this.safetyLatched) return this.lastFault;
            const event = this._recordGraphicsFault(code, level, message, details);
            this.safetyLatched = true;
            this.safetyReason = String(code);
            this.enabled = false;
            this.needsDraw = false;
            this.lastDrawRequestAt = 0;
            this._cancelPendingFrame();
            return event;
        }

        _contextIsLost() {
            if (!this.gl || typeof this.gl.isContextLost !== 'function') return false;
            try { return Boolean(this.gl.isContextLost()); }
            catch (_) { return false; }
        }

        _checkContextBeforeDraw() {
            if (this.safetyLatched) return true;
            if (this._contextIsLost()) {
                this.contextState = 'LOST';
                this.lastContextEvent = 'isContextLost()';
                this._enterGraphicsSafety('WEBGL_CONTEXT_LOST', 6,
                    'WebGL reported that its context is lost before a renderer draw.');
                return true;
            }
            return false;
        }

        _recordDrawDuration(duration, source) {
            this.lastDrawDurationMs = duration;
            if (duration > this.maxDrawDurationMs) this.maxDrawDurationMs = duration;
            if (duration >= this.drawSlowThresholdMs) {
                this.slowDrawCount++;
                this.consecutiveSlowDraws++;
                if (this.consecutiveSlowDraws >= 3 && !this.slowDrawWarningIssued) {
                    this.slowDrawWarningIssued = true;
                    const now = performance.now();
                    const lastWarning = this.performanceFaultTimes.SLOW_DRAW_STREAK ?? -Infinity;
                    if (now - lastWarning >= 10000) {
                        this.performanceFaultTimes.SLOW_DRAW_STREAK = now;
                        this._recordGraphicsFault('SLOW_DRAW_STREAK', 3,
                            'Three or more consecutive renderer draws exceeded 100 ms.', {
                                durationMs: Number(duration.toFixed(2)),
                                slowDrawCount: this.slowDrawCount,
                                source
                            });
                    }
                }
            } else {
                this.consecutiveSlowDraws = 0;
                this.slowDrawWarningIssued = false;
            }
        }

        _recordRendererException(error, source) {
            this.rendererExceptionDetected = true;
            const message = error && error.message ? error.message : String(error);
            const stack = error && error.stack ? String(error.stack).slice(0, 4000) : '';
            this.lastError = `${source} error: ${message}`;
            this._enterGraphicsSafety('RENDERER_DRAW_EXCEPTION', 5, this.lastError, { source, stack });
            console.error('[MMIC V-Sync v0.4.3] Renderer exception; graphics failsafe engaged.', error);
        }

        _getHighestPendingFault() {
            let selected = null;
            for (const event of this.faultHistory) {
                if (event.sequence <= this.acknowledgedFaultSequence) continue;
                if (!selected || event.level > selected.level ||
                    (event.level === selected.level && event.sequence > selected.sequence)) selected = event;
            }
            return selected;
        }

        _updateContextStatus() {
            if (!this.gl) {
                if (!this.contextState || this.contextState === 'Not checked') this.contextState = 'Unavailable';
                return;
            }
            try {
                if (typeof this.gl.isContextLost === 'function' && this.gl.isContextLost()) {
                    this.contextState = 'LOST';
                    this._enterGraphicsSafety('WEBGL_CONTEXT_LOST', 6,
                        'MENGINE polled the graphics sensor and WebGL reported a lost context.');
                } else if (this.contextState !== 'Restored event received; renderer recovery not yet validated') {
                    this.contextState = 'Available';
                }
            } catch (_) {
                this.contextState = 'Status check failed';
            }
        }

        _attachRenderer() {
            const renderer = this.runtime.renderer;
            if (!renderer || typeof renderer.draw !== 'function') {
                this.lastError = 'Renderer is not available yet.';
                return false;
            }
            if (renderer === this.renderer && renderer.draw === this.wrappedDraw) return true;

            this._restoreRenderer();
            this.renderer = renderer;
            this.originalDraw = renderer.draw;
            this._attachContextListeners(renderer);

            const extension = this;
            const original = this.originalDraw;
            this.wrappedDraw = function (...args) {
                // When a critical graphics fault is latched, suppress further calls
                // into the original renderer until MENGINE explicitly releases guard.
                if (extension.safetyLatched) return undefined;
                if (!extension.enabled) return original.apply(this, args);
                if (extension._checkContextBeforeDraw()) return undefined;

                const canvas = extension.canvas;
                if (canvas && (canvas.width !== extension.canvasWidth || canvas.height !== extension.canvasHeight)) {
                    extension.canvasWidth = canvas.width;
                    extension.canvasHeight = canvas.height;
                    extension._cancelPendingFrame();
                    extension.needsDraw = false;
                    const drawStart = performance.now();
                    try {
                        const result = original.apply(this, args);
                        const duration = performance.now() - drawStart;
                        extension._recordDrawDuration(duration, 'resize');
                        extension.sampleDraws++;
                        extension.renderedFrames++;
                        extension.resizeRedraws++;
                        return result;
                    } catch (error) {
                        extension._recordRendererException(error, 'Resize redraw');
                        return undefined;
                    }
                }

                if (this.dirty === false) return undefined;
                extension.sampleRequests++;
                extension.drawRequests++;
                if (extension.needsDraw || extension.pendingFrame !== null) {
                    extension.sampleCoalesced++;
                    extension.coalescedRequests++;
                } else {
                    extension.lastDrawRequestAt = performance.now();
                }
                extension.needsDraw = true;
                extension._scheduleDraw();
                return undefined;
            };

            renderer.draw = this.wrappedDraw;
            if (renderer.draw !== this.wrappedDraw) {
                this.lastError = 'Could not attach to renderer.draw.';
                this._restoreRenderer();
                return false;
            }
            this.lastError = '';
            return true;
        }

        _restoreRenderer() {
            if (this.renderer && this.originalDraw && this.renderer.draw === this.wrappedDraw) {
                this.renderer.draw = this.originalDraw;
            }
            this._removeContextListeners();
            this.renderer = null;
            this.originalDraw = null;
            this.wrappedDraw = null;
            this.canvasWidth = null;
            this.canvasHeight = null;
        }

        _cancelPendingFrame() {
            if (this.pendingFrame !== null) {
                cancelAnimationFrame(this.pendingFrame);
                this.pendingFrame = null;
            }
        }

        _scheduleDraw() {
            if (!this.enabled || this.safetyLatched || this.pendingFrame !== null || document.hidden) return;
            try {
                this.pendingFrame = requestAnimationFrame((timestamp) => this._drawFrame(timestamp));
            } catch (error) {
                const message = error && error.message ? error.message : String(error);
                this.lastError = `requestAnimationFrame failed: ${message}`;
                this._enterGraphicsSafety('RAF_SCHEDULER_FAILED', 5, this.lastError, {
                    stack: error && error.stack ? String(error.stack).slice(0, 4000) : ''
                });
                console.error('[MMIC V-Sync v0.4.3] RAF scheduler failed; graphics failsafe engaged.', error);
            }
        }

        _recordFrameInterval(timestamp) {
            if (this.lastFrameTimestamp > 0) {
                const interval = timestamp - this.lastFrameTimestamp;
                if (interval > 0 && Number.isFinite(interval)) {
                    this.frameIntervals[this.frameIntervalIndex] = interval;
                    this.frameIntervalIndex = (this.frameIntervalIndex + 1) % this.maxFrameHistory;
                    if (this.frameIntervalCount < this.maxFrameHistory) this.frameIntervalCount++;
                }
            }
            this.lastFrameTimestamp = timestamp;
        }

        _drawFrame(timestamp) {
            this.pendingFrame = null;
            if (!this.enabled || this.safetyLatched || !this.needsDraw || document.hidden) return;

            // Reattach only if the VM swapped renderers or another component replaced draw.
            if (this.runtime.renderer !== this.renderer || !this.renderer || this.renderer.draw !== this.wrappedDraw) {
                if (!this._attachRenderer()) {
                    this._enterGraphicsSafety('RENDERER_REATTACH_FAILED', 5,
                        'The extension could not reattach its renderer after a renderer change.',
                        { error: this.lastError });
                    return;
                }
            }

            if (this._checkContextBeforeDraw()) return;

            this.needsDraw = false;
            const callbackTime = performance.now();
            if (this.lastDrawRequestAt > 0) {
                const delay = Math.max(0, callbackTime - this.lastDrawRequestAt);
                this.lastRequestToRafMs = delay;
                if (delay > this.maxRequestToRafMs) this.maxRequestToRafMs = delay;
                this.lastDrawRequestAt = 0;
                if (!document.hidden && delay >= this.rafDelayWarningMs) {
                    this.stallCount++;
                    const now = performance.now();
                    const lastWarning = this.performanceFaultTimes.RAF_RESPONSE_DELAY ?? -Infinity;
                    if (now - lastWarning >= 10000) {
                        this.performanceFaultTimes.RAF_RESPONSE_DELAY = now;
                        this._recordGraphicsFault('RAF_RESPONSE_DELAY', 3,
                            'A visible-tab draw request waited at least 1000 ms for its RAF callback.',
                            { delayMs: Number(delay.toFixed(2)), stallCount: this.stallCount });
                    }
                }
            }

            try {
                if (this.renderer.dirty === false) return;
                const frameTime = Number.isFinite(timestamp) ? timestamp : performance.now();
                this._recordFrameInterval(frameTime);
                const drawStart = performance.now();
                try {
                    this.originalDraw.call(this.renderer);
                } finally {
                    this._recordDrawDuration(performance.now() - drawStart, 'raf');
                }
                this.sampleDraws++;
                this.renderedFrames++;
            } catch (error) {
                this._recordRendererException(error, 'Renderer draw');
            }
        }

        enableVSync() {
            if (this.enabled) return;
            if (this.safetyLatched) {
                this.lastError = `Graphics failsafe is active (${this.safetyReason}). MENGINE must validate recovery before V-Sync can restart.`;
                console.warn('[MMIC V-Sync v0.4.3]', this.lastError);
                return;
            }
            if (this.runtime.interpolationEnabled ||
                (this.runtime.frameLoop && this.runtime.frameLoop._interpolationAnimation)) {
                this.lastError = 'Turn off project interpolation before testing this prototype.';
                console.warn('[MMIC V-Sync v0.4.3]', this.lastError);
                return;
            }

            this.enabled = true;
            this.needsDraw = false;
            this.pendingFrame = null;
            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.sampleRequests = 0;
            this.sampleCoalesced = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;
            this.measuredRequestRate = 0;
            this.measuredCoalescedRate = 0;
            this.drawRequests = 0;
            this.coalescedRequests = 0;
            this.renderedFrames = 0;
            this.resizeRedraws = 0;
            this.frameIntervalCount = 0;
            this.frameIntervalIndex = 0;
            this.lastFrameTimestamp = 0;
            this.lastDrawDurationMs = 0;
            this.maxDrawDurationMs = 0;
            this.lastRequestToRafMs = 0;
            this.maxRequestToRafMs = 0;
            this.lastDrawRequestAt = 0;
            this.slowDrawCount = 0;
            this.consecutiveSlowDraws = 0;
            this.slowDrawWarningIssued = false;
            this.stallCount = 0;
            this.lastError = '';

            if (!this._attachRenderer()) {
                this.enabled = false;
                return;
            }
            if (this.renderer && this.renderer.dirty) {
                this.needsDraw = true;
                this._scheduleDraw();
            }
        }

        disableVSync() {
            if (!this.enabled && !this.wrappedDraw) return;
            this.enabled = false;
            this._cancelPendingFrame();
            this.needsDraw = false;

            // After a critical renderer fault, do not restore/call the original draw
            // path. The wrapper remains installed as a no-draw guard until MENGINE
            // has validated recovery or the runtime is disposed.
            if (this.safetyLatched) return;

            const renderer = this.renderer;
            const original = this.originalDraw;
            this._restoreRenderer();
            if (renderer && original) {
                try { original.call(renderer); }
                catch (error) { console.error('[MMIC V-Sync v0.4.3] Error restoring renderer:', error); }
            }
        }

        releaseGraphicsSafetyLatch() {
            if (!this.safetyLatched) return true;
            const currentRenderer = this.runtime.renderer;
            const candidateGL = currentRenderer && currentRenderer !== this.renderer
                ? this._getGL(currentRenderer) : this.gl;
            if (!candidateGL || typeof candidateGL.isContextLost !== 'function' || candidateGL.isContextLost()) {
                this.lastError = 'Cannot release graphics failsafe: a valid, non-lost WebGL context is not available.';
                return false;
            }
            // This only removes the extension's draw guard. It does not rebuild
            // textures/framebuffers; MENGINE must validate/rebuild renderer resources first.
            this.safetyLatched = false;
            this.safetyReason = '';
            this.enabled = false;
            this.needsDraw = false;
            this._cancelPendingFrame();
            this._restoreRenderer();
            this.lastError = '';
            return true;
        }

        _updateRates() {
            const now = performance.now();
            const elapsed = now - this.sampleStartedAt;
            if (elapsed >= 1000) {
                const scale = 1000 / elapsed;
                this.measuredStepRate = this.sampleSteps * scale;
                this.measuredRenderRate = this.sampleDraws * scale;
                this.measuredRequestRate = this.sampleRequests * scale;
                this.measuredCoalescedRate = this.sampleCoalesced * scale;
                this.sampleSteps = 0;
                this.sampleDraws = 0;
                this.sampleRequests = 0;
                this.sampleCoalesced = 0;
                this.sampleStartedAt = now;
            }
        }

        _round(value) { return Math.round(value * 10) / 10; }
        isEnabled() { return this.enabled; }
        getStepRate() { this._updateRates(); return this._round(this.measuredStepRate); }
        getRenderRate() { this._updateRates(); return this._round(this.measuredRenderRate); }
        getRequestRate() { this._updateRates(); return this._round(this.measuredRequestRate); }
        getCoalescedRate() { this._updateRates(); return this._round(this.measuredCoalescedRate); }
        getContextStatus() { this._updateContextStatus(); return this.contextState; }
        getLastContextEvent() { return this.lastContextEvent; }
        getResizeRedraws() { return this.resizeRedraws; }
        getHQEnabled() { return Boolean(this.runtime.renderer && this.runtime.renderer.useHighQualityRender); }
        getPenSkinDetected() { return Boolean(this.runtime.renderer && this._getPenSkin(this.runtime.renderer).skin); }
        getPenDetails() { return this._describePenSkin(); }

        // MENGINE-facing, polling-safe fault reporters. Faults remain latched until
        // acknowledged; acknowledgement does not clear the graphics failsafe.
        getGraphicsFaultPending() { return this.faultSequence > this.acknowledgedFaultSequence; }
        getGraphicsFaultLevel() {
            const fault = this._getHighestPendingFault();
            return fault ? fault.level : 0;
        }
        getGraphicsFaultLevelName() {
            const names = ['NONE', 'MINOR_IGNORED', 'NORMAL_ERROR', 'POTENTIALLY_SERIOUS',
                'SERIOUS_ERROR', 'COMPONENT_FAILURE', 'CRITICAL_FAULT',
                'CRITICAL_SYSTEM_FAULT', 'CRITICAL_PAGE_FAULT'];
            return names[this.getGraphicsFaultLevel()] || 'UNKNOWN';
        }
        getGraphicsFaultCode() {
            const fault = this._getHighestPendingFault() || this.lastFault;
            return fault ? fault.code : 'NONE';
        }
        getGraphicsFaultMessage() {
            const fault = this._getHighestPendingFault() || this.lastFault;
            return fault ? fault.message : 'No graphics fault recorded.';
        }
        getGraphicsFaultSequence() { return this.faultSequence; }
        getGraphicsFaultCount() {
            // Sequence arithmetic remains accurate even when the 16-entry JSON
            // history has wrapped and older unacknowledged entries were evicted.
            return Math.max(0, this.faultSequence - this.acknowledgedFaultSequence);
        }
        getGraphicsFaultJSON() {
            const fault = this._getHighestPendingFault() || this.lastFault;
            return fault ? JSON.stringify(fault) : '{}';
        }
        getGraphicsFaultHistoryJSON() { return JSON.stringify(this.faultHistory); }
        acknowledgeGraphicsFaults() { this.acknowledgedFaultSequence = this.faultSequence; }
        acknowledgeGraphicsFaultsThrough(args) {
            const requested = Math.trunc(Number(args && args.SEQUENCE) || 0);
            this.acknowledgedFaultSequence = Math.max(this.acknowledgedFaultSequence,
                Math.min(this.faultSequence, Math.max(0, requested)));
        }
        getWebGLContextLost() {
            const lost = this._contextIsLost();
            if (lost && !this.safetyLatched) {
                this.contextState = 'LOST';
                this._enterGraphicsSafety('WEBGL_CONTEXT_LOST', 6,
                    'MENGINE polled the graphics sensor and WebGL reported a lost context.');
            }
            return lost || this.contextState === 'LOST';
        }
        getRendererExceptionDetected() { return this.rendererExceptionDetected; }
        getGraphicsSafetyLatched() { return this.safetyLatched; }
        getGraphicsHealthState() {
            if (this.safetyLatched) return `FAILSAFE:${this.safetyReason}`;
            const fault = this._getHighestPendingFault();
            if (fault && fault.level >= 2) return `DEGRADED:${fault.code}`;
            if (!this.renderer || !this.wrappedDraw) return 'NOT_ATTACHED';
            if (this._contextIsLost()) return 'CONTEXT_LOST';
            return this.enabled ? 'HEALTHY' : 'DISABLED';
        }
        getLastDrawDuration() { return this._round(this.lastDrawDurationMs); }
        getMaxDrawDuration() { return this._round(this.maxDrawDurationMs); }
        getLastRequestToRafDelay() { return this._round(this.lastRequestToRafMs); }
        getMaxRequestToRafDelay() { return this._round(this.maxRequestToRafMs); }
        getSlowDrawCount() { return this.slowDrawCount; }
        getStallCount() { return this.stallCount; }
        getRendererAttached() { return Boolean(this.renderer && this.wrappedDraw && this.renderer.draw === this.wrappedDraw); }
        getPageCrashDetectionCapability() {
            return 'NOT DETECTABLE IN-PAGE: a browser/tab process crash stops this JavaScript. Use an external watchdog; this sensor detects only events delivered while the page is executing.';
        }

        getFramePacing() {
            const count = this.frameIntervalCount;
            if (!count) return 'Collecting frame intervals';
            const values = new Array(count);
            const first = count === this.maxFrameHistory ? this.frameIntervalIndex : 0;
            for (let i = 0; i < count; i++) {
                values[i] = this.frameIntervals[(first + i) % this.maxFrameHistory];
            }
            values.sort((a, b) => a - b);
            const sum = values.reduce((total, value) => total + value, 0);
            const average = sum / values.length;
            const median = values[Math.floor(values.length / 2)];
            const maximum = values[values.length - 1];
            let estimatedMissed = 0;
            if (median > 0) {
                for (const interval of values) estimatedMissed += Math.max(0, Math.round(interval / median) - 1);
            }
            return `samples=${values.length}; average=${average.toFixed(2)}ms; median=${median.toFixed(2)}ms; max=${maximum.toFixed(2)}ms; estimated long gaps vs median=${estimatedMissed}`;
        }

        getPipelineStats() {
            this._updateRates();
            return `draw requests=${this.drawRequests}; coalesced=${this.coalescedRequests}; rendered=${this.renderedFrames}; immediate resize redraws=${this.resizeRedraws}; request rate=${this._round(this.measuredRequestRate)}/s; coalesced rate=${this._round(this.measuredCoalescedRate)}/s`;
        }

        getStatus() {
            if (this.safetyLatched) return `FAILSAFE active: ${this.safetyReason}`;
            if (this.lastError) return this.lastError;
            return this.enabled ? 'Enabled' : 'Disabled';
        }
    }

    Scratch.extensions.register(new MMICVSyncOptimized());
})(Scratch);
