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

            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;

            this.onStepEnd = () => {
                this.sampleSteps++;
                if (this.enabled) {
                    this.needsDraw = true;
                    this._scheduleDraw();
                }
            };
            this.onVisibilityChange = () => {
                if (this.enabled && !document.hidden && this.needsDraw) {
                    this._scheduleDraw();
                }
            };
            this.onRuntimeStarted = () => {
                if (this.enabled && this.needsDraw) this._scheduleDraw();
            };
            this.onRuntimeDisposed = () => this.disableVSync();

            this.runtime.on('RUNTIME_STEP_END', this.onStepEnd);
            this.runtime.on('RUNTIME_STARTED', this.onRuntimeStarted);
            this.runtime.on('RUNTIME_DISPOSED', this.onRuntimeDisposed);
            document.addEventListener('visibilitychange', this.onVisibilityChange);
        }

        getInfo() {
            return {
                id: 'mmicVsyncPrototype',
                name: 'MMIC V-Sync TEST',
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
                        opcode: 'getStatus',
                        blockType: Scratch.BlockType.REPORTER,
                        text: 'V-Sync status'
                    }
                ]
            };
        }

        _restoreRenderer() {
            if (this.renderer && this.originalDraw && this.renderer.draw === this.wrappedDraw) {
                this.renderer.draw = this.originalDraw;
            }
            this.renderer = null;
            this.originalDraw = null;
            this.wrappedDraw = null;
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

            const extension = this;
            const original = this.originalDraw;
            this.wrappedDraw = function (...args) {
                if (!extension.enabled) {
                    return original.apply(this, args);
                }
                // Do not draw here. Mark the scene dirty and let the next
                // browser animation-frame callback perform the actual draw.
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
            if (!this.enabled) return;

            if (!this._attachRenderer()) return;
            if (document.hidden || !this.needsDraw) return;

            this.needsDraw = false;
            try {
                // Call the original draw method directly, bypassing our wrapper.
                this.originalDraw.call(this.renderer);
                this.sampleDraws++;
            } catch (error) {
                this.lastError = `Renderer error: ${error && error.message ? error.message : String(error)}`;
                console.error('[MMIC V-Sync Prototype]', error);
            }
        }

        enableVSync() {
            if (this.enabled) return;

            // This prototype deliberately does not change the project's FPS,
            // interpolation setting, compiler settings, or VM step function.
            if (this.runtime.interpolationEnabled || this.runtime.frameLoop._interpolationAnimation) {
                this.lastError = 'Turn off project interpolation before testing this prototype.';
                console.warn('[MMIC V-Sync Prototype]', this.lastError);
                return;
            }

            this.enabled = true;
            this.needsDraw = true;
            this.sampleStartedAt = performance.now();
            this.sampleSteps = 0;
            this.sampleDraws = 0;
            this.measuredStepRate = 0;
            this.measuredRenderRate = 0;

            if (!this._attachRenderer()) {
                this.enabled = false;
                return;
            }
            this._scheduleDraw();
        }

        disableVSync() {
            if (!this.enabled && !this.wrappedDraw) return;

            this.enabled = false;
            if (this.pendingFrame !== null) {
                cancelAnimationFrame(this.pendingFrame);
                this.pendingFrame = null;
            }

            const renderer = this.renderer;
            const original = this.originalDraw;
            this._restoreRenderer();

            // Restore the normal renderer first, then paint one final frame.
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

        getStatus() {
            if (this.lastError) return this.lastError;
            return this.enabled ? 'Enabled' : 'Disabled';
        }
    }

    Scratch.extensions.register(new MMICVSyncPrototype());
})(Scratch);
