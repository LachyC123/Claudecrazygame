// INTERFACE: new Audio(ctx); .update(dt); .dispose()  — replaced by the Audio agent.
export class Audio {
  constructor(ctx) { this.ctx = ctx; }
  update(dt) {}
  dispose() {}
}
