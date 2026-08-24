// INTERFACE: new HUD(ctx); .update(dt); .dispose()  — replaced by the HUD agent.
export class HUD {
  constructor(ctx) { this.ctx = ctx; }
  update(dt) {}
  dispose() {}
}
