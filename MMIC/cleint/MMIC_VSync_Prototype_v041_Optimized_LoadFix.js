(function (Scratch) {
    'use strict';

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

            // A small rolling history, updated only once per actual RAF callback.
            this.frameIntervals = [];
            this.maxFrameHistory = 120;
            this.lastFrameTimestamp = 0;

            this.onStepEnd = () => { this.sampleSteps++; };
            this.onVisibilityChange = () => {
                if (this.enabled && !document.hidden && this.renderer && this.renderer.dirty) {
                    this.needsDraw = true;
                    this._scheduleDraw();
                }
            };
            this.onRuntimeDisposed = () => this.disableVSync();

            this.runtime.on('RUNTIME_STEP_END', this.onStepEnd);
            this.runtime.on('RUNTIME_DISPOSED', this.onRuntimeDisposed);
            document.addEventListener('visibilitychange', this.onVisibilityChange);
        }

        getInfo() {
            return {
                id: 'mmicvsyncoptimized',
                name: 'MMIC V-Sync TEST v0.4.1 Optimized Load Fix',
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
                    { opcode: 'getStatus', blockType: Scratch.BlockType.REPORTER, text: 'V-Sync status' }
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
            this.canvas = null;
            this.gl = null;
            this.onContextLost = null;
            this.onContextRestored = null;
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
                this.contextState = 'LOST';
                this.lastContextEvent = 'webglcontextlost';
                this.lastError = 'The browser reported that the WebGL context was lost.';
                console.error('[MMIC V-Sync v0.4.1]', this.lastError, event);
            };
            this.onContextRestored = () => {
                this.contextState = 'Restored event received';
                this.lastContextEvent = 'webglcontextrestored';
                console.warn('[MMIC V-Sync v0.4.1] WebGL context restored event received.');
            };
            this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
            this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
            this._updateContextStatus();
        }

        _updateContextStatus() {
            if (!this.gl) {
                if (!this.contextState || this.contextState === 'Not checked') this.contextState = 'Unavailable';
                return;
            }
            try {
                if (typeof this.gl.isContextLost === 'function' && this.gl.isContextLost()) this.contextState = 'LOST';
                else if (this.contextState !== 'Restored event received') this.contextState = 'Available';
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
                if (!extension.enabled) return original.apply(this, args);

                // Use the cached canvas reference: resolving renderer.gl/canvas on every
                // draw request was unnecessary work on the hottest path.
                const canvas = extension.canvas;
                if (canvas && (canvas.width !== extension.canvasWidth || canvas.height !== extension.canvasHeight)) {
                    extension.canvasWidth = canvas.width;
                    extension.canvasHeight = canvas.height;
                    extension._cancelPendingFrame();
                    extension.needsDraw = false;
                    try {
                        const result = original.apply(this, args);
                        extension.sampleDraws++;
                        extension.renderedFrames++;
                        extension.resizeRedraws++;
                        extension._updateContextStatus();
                        return result;
                    } catch (error) {
                        extension.lastError = `Resize redraw error: ${error && error.message ? error.message : String(error)}`;
                        console.error('[MMIC V-Sync v0.4.1]', error);
                        return undefined;
                    }
                }

                if (this.dirty === false) return undefined;
                extension.sampleRequests++;
                extension.drawRequests++;
                if (extension.needsDraw || extension.pendingFrame !== null) {
                    extension.sampleCoalesced++;
                    extension.coalescedRequests++;
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
            if (!this.enabled || this.pendingFrame !== null || document.hidden) return;
            this.pendingFrame = requestAnimationFrame((timestamp) => this._drawFrame(timestamp));
        }

        _recordFrameInterval(timestamp) {
            if (this.lastFrameTimestamp > 0) {
                const interval = timestamp - this.lastFrameTimestamp;
                if (interval > 0 && Number.isFinite(interval)) {
                    this.frameIntervals.push(interval);
                    if (this.frameIntervals.length > this.maxFrameHistory) this.frameIntervals.shift();
                }
            }
            this.lastFrameTimestamp = timestamp;
        }

        _drawFrame(timestamp) {
            this.pendingFrame = null;
            if (!this.enabled || !this.needsDraw || document.hidden) return;

            // Reattach only if the VM swapped renderers or another component replaced draw.
            if (this.runtime.renderer !== this.renderer || !this.renderer || this.renderer.draw !== this.wrappedDraw) {
                if (!this._attachRenderer()) return;
            }

            const gl = this.gl;
            if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
                this.contextState = 'LOST';
                this.lastError = 'Draw skipped because the WebGL context is lost.';
                return;
            }

            this.needsDraw = false;
            try {
                if (this.renderer.dirty === false) return;
                const frameTime = Number.isFinite(timestamp) ? timestamp : performance.now();
                this._recordFrameInterval(frameTime);
                this.originalDraw.call(this.renderer);
                this.sampleDraws++;
                this.renderedFrames++;
                this._updateContextStatus();
            } catch (error) {
                this.lastError = `Renderer error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync v0.4.1]', error);
            }
        }

        enableVSync() {
            if (this.enabled) return;
            if (this.runtime.interpolationEnabled ||
                (this.runtime.frameLoop && this.runtime.frameLoop._interpolationAnimation)) {
                this.lastError = 'Turn off project interpolation before testing this prototype.';
                console.warn('[MMIC V-Sync v0.4.1]', this.lastError);
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
            this.frameIntervals.length = 0;
            this.lastFrameTimestamp = 0;
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
            const renderer = this.renderer;
            const original = this.originalDraw;
            this._restoreRenderer();
            if (renderer && original) {
                try { original.call(renderer); }
                catch (error) { console.error('[MMIC V-Sync v0.4.1] Error restoring renderer:', error); }
            }
            this.needsDraw = false;
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

        getFramePacing() {
            const values = this.frameIntervals.slice().sort((a, b) => a - b);
            if (!values.length) return 'Collecting frame intervals';
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
            if (this.lastError) return this.lastError;
            return this.enabled ? 'Enabled' : 'Disabled';
        }
    }

    Scratch.extensions.register(new MMICVSyncOptimized());
})(Scratch);
