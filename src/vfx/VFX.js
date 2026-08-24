// INTERFACE: new VFX(ctx); .update(dt); .dispose()  — replaced by the VFX agent.
export class VFX {
  constructor(ctx) { this.ctx = ctx; }
  update(dt) {}
  dispose() {}
}
