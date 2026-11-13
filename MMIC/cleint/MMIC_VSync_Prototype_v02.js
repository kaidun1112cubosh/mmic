(function (Scratch) {
    'use strict';

    if (!Scratch.extensions.unsandboxed) {
        throw new Error('MMIC V-Sync Prototype must be loaded unsandboxed.');
    }

    const vm = Scratch.vm;
    if (!vm || !vm.runtime) {
        throw new Error('MMIC V-Sync Prototype could not access the PenguinMod VM.');
    }

    class MMICVSyncPrototype {
        constructor() {
            this.runtime = vm.runtime;
            this.enabled = false;
            this.renderer = null;
            this.originalDraw = null;
            this.wrappedDraw = null;
            this.pendingFrame = null;
            this.needsDraw = false;
            this.lastError = '';
            this.contextState = 'Not checked';
            this.lastContextEvent = 'None';
            this.resizeRedraws = 0;
            this.lastDrawTime = 0;
            this.canvasWidth = null;
            this.canvasHeight = null;
            this.canvas = null;
            this.gl = null;
            this.onContextLost = null;
            this.onContextRestored = null;

            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;

            this.onStepEnd = () => {
                this.sampleSteps++;
            };
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
                id: 'mmicVsyncPrototype',
                name: 'MMIC V-Sync TEST v0.2',
                color1: '#2878B8',
                color2: '#1F6399',
                color3: '#174D78',
                blocks: [
                    {
                        opcode: 'enableVSync',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'enable display-synchronized rendering'
                    },
                    {
                        opcode: 'disableVSync',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'disable display-synchronized rendering'
                    },
                    {
                        opcode: 'isEnabled',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'display-synchronized rendering enabled?'
                    },
                    {
                        opcode: 'getStepRate',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'measured VM steps per second'
                    },
                    {
                        opcode: 'getRenderRate',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'measured rendered frames per second'
                    },
                    {
                        opcode: 'getContextStatus',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'WebGL context status'
                    },
                    {
                        opcode: 'getLastContextEvent',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'last WebGL context event'
                    },
                    {
                        opcode: 'getResizeRedraws',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'immediate resize redraws'
                    },
                    {
                        opcode: 'getStatus',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'V-Sync status'
                    }
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

        _removeContextListeners() {
            if (this.canvas && this.onContextLost) {
                this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
            }
            if (this.canvas && this.onContextRestored) {
                this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
            }
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
                // Diagnostic only: deliberately do not preventDefault() or attempt
                // to rebuild PenguinMod's internal WebGL resources.
                this.contextState = 'LOST';
                this.lastContextEvent = 'webglcontextlost';
                this.lastError = 'The browser reported that the WebGL context was lost.';
                console.error('[MMIC V-Sync Prototype]', this.lastError, event);
            };
            this.onContextRestored = () => {
                this.contextState = 'Restored event received (renderer resources may need rebuilding)';
                this.lastContextEvent = 'webglcontextrestored';
                console.warn('[MMIC V-Sync Prototype] WebGL context restored event received.');
            };
            this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
            this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
            this._updateContextStatus();
        }

        _updateContextStatus() {
            if (!this.gl) {
                if (!this.contextState || this.contextState === 'Not checked') {
                    this.contextState = 'Unavailable';
                }
                return;
            }
            try {
                if (typeof this.gl.isContextLost === 'function' && this.gl.isContextLost()) {
                    this.contextState = 'LOST';
                } else if (this.contextState !== 'Restored event received (renderer resources may need rebuilding)') {
                    this.contextState = 'Available';
                }
            } catch (error) {
                this.contextState = 'Status check failed';
            }
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

        _drawImmediatelyAfterResize(renderer, original, args) {
            // Setting canvas.width or canvas.height clears its drawing buffer.
            // PenguinMod normally redraws immediately after resize(). If we defer
            // this particular redraw to the next RAF, one blank canvas frame can
            // be displayed. Keep resize recovery synchronous; normal frames remain
            // RAF-synchronized.
            this._cancelPendingFrame();
            this.needsDraw = false;
            try {
                const result = original.apply(renderer, args);
                this.sampleDraws++;
                this.resizeRedraws++;
                this.lastDrawTime = performance.now();
                this._updateContextStatus();
                return result;
            } catch (error) {
                this.lastError = `Resize redraw error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync Prototype]', error);
                return undefined;
            }
        }

        _attachRenderer() {
            const renderer = this.runtime.renderer;
            if (!renderer || typeof renderer.draw !== 'function') {
                this.lastError = 'Renderer is not available yet.';
                return false;
            }

            if (renderer === this.renderer && renderer.draw === this.wrappedDraw) {
                return true;
            }

            this._restoreRenderer();
            this.renderer = renderer;
            this.originalDraw = renderer.draw;
            this._attachContextListeners(renderer);

            const extension = this;
            const original = this.originalDraw;
            this.wrappedDraw = function (...args) {
                if (!extension.enabled) {
                    return original.apply(this, args);
                }

                const canvas = extension._getCanvas(this);
                if (canvas) {
                    const resized = canvas.width !== extension.canvasWidth ||
                        canvas.height !== extension.canvasHeight;
                    if (resized) {
                        extension.canvasWidth = canvas.width;
                        extension.canvasHeight = canvas.height;
                        extension._updateContextStatus();
                        if (this.dirty !== false) {
                            return extension._drawImmediatelyAfterResize(this, original, args);
                        }
                    }
                }

                // RenderWebGL.draw() is a no-op when dirty is false. Avoid queuing
                // an animation frame when there is no changed scene to present.
                if (this.dirty === false) return undefined;

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

        _scheduleDraw() {
            if (!this.enabled || this.pendingFrame !== null || document.hidden) return;
            this.pendingFrame = requestAnimationFrame(() => this._drawFrame());
        }

        _drawFrame() {
            this.pendingFrame = null;
            if (!this.enabled || !this.needsDraw) return;
            if (!this._attachRenderer()) return;
            if (document.hidden) return;

            const gl = this._getGL(this.renderer);
            if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
                this.contextState = 'LOST';
                this.lastError = 'Draw skipped because the WebGL context is lost.';
                return;
            }

            this.needsDraw = false;
            try {
                // Only draw if the scene is still dirty. The VM can have drawn or
                // cleared the dirty flag through another renderer path meanwhile.
                if (this.renderer.dirty === false) return;
                this.originalDraw.call(this.renderer);
                this.sampleDraws++;
                this.lastDrawTime = performance.now();
                this._updateContextStatus();
            } catch (error) {
                this.lastError = `Renderer error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync Prototype]', error);
            }
        }

        enableVSync() {
            if (this.enabled) return;

            if (this.runtime.interpolationEnabled ||
                (this.runtime.frameLoop && this.runtime.frameLoop._interpolationAnimation)) {
                this.lastError = 'Turn off project interpolation before testing this prototype.';
                console.warn('[MMIC V-Sync Prototype]', this.lastError);
                return;
            }

            this.enabled = true;
            this.needsDraw = false;
            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;
            this.resizeRedraws = 0;
            this.lastError = '';

            if (!this._attachRenderer()) {
                this.enabled = false;
                return;
            }

            // Request an initial frame only when the renderer already has a
            // pending dirty scene (do not force a needless full redraw).
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
                try {
                    original.call(renderer);
                } catch (error) {
                    console.error('[MMIC V-Sync Prototype] Error restoring renderer:', error);
                }
            }
            this.needsDraw = false;
        }

        _updateRates() {
            const now = performance.now();
            const elapsed = now - this.sampleStartedAt;
            if (elapsed >= 1000) {
                this.measuredStepRate = this.sampleSteps * 1000 / elapsed;
                this.measuredRenderRate = this.sampleDraws * 1000 / elapsed;
                this.sampleSteps = 0;
                this.sampleDraws = 0;
                this.sampleStartedAt = now;
            }
        }

        isEnabled() {
            return this.enabled;
        }

        getStepRate() {
            this._updateRates();
            return Math.round(this.measuredStepRate * 10) / 10;
        }

        getRenderRate() {
            this._updateRates();
            return Math.round(this.measuredRenderRate * 10) / 10;
        }

        getContextStatus() {
            this._updateContextStatus();
            return this.contextState;
        }

        getLastContextEvent() {
            return this.lastContextEvent;
        }

        getResizeRedraws() {
            return this.resizeRedraws;
        }

        getStatus() {
            if (this.lastError) return this.lastError;
            return this.enabled ? 'Enabled' : 'Disabled';
        }
    }

    Scratch.extensions.register(new MMICVSyncPrototype());
})(Scratch);
