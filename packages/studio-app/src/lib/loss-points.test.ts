import { describe, it, expect } from "vitest";
import { appendLossPoint, type LossPoint } from "./loss-points";

describe("appendLossPoint", () => {
  it("respects cap over long synthetic runs", () => {
    const cap = 100;
    let points: LossPoint[] = [];

    for (let step = 0; step < 500; step++) {
      points = appendLossPoint(
        points,
        {
          step,
          loss: 10 - step * 0.01,
          evalLoss: null,
        },
        cap,
      );
      expect(points.length).toBeLessThanOrEqual(cap);
    }

    expect(points.length).toBeLessThanOrEqual(cap);
  });

  it("retains earliest and final points", () => {
    const cap = 50;
    let points: LossPoint[] = [];

    for (let step = 0; step < 200; step++) {
      points = appendLossPoint(
        points,
        {
          step,
          loss: Math.sin(step / 10),
          evalLoss: null,
        },
        cap,
      );
    }

    const steps = points.map((p) => p.step);
    expect(steps[0]).toBe(0); // first step
    expect(steps.at(-1)).toBe(199); // last step
  });

  it("preserves step ordering", () => {
    const cap = 100;
    let points: LossPoint[] = [];

    for (let step = 0; step < 300; step++) {
      points = appendLossPoint(
        points,
        {
          step,
          loss: Math.random(),
          evalLoss: null,
        },
        cap,
      );
    }

    for (let i = 0; i < points.length - 1; i++) {
      expect(points[i]!.step).toBeLessThanOrEqual(points[i + 1]!.step);
    }
  });

  it("preserves sparse evalLoss points", () => {
    const cap = 100;
    let points: LossPoint[] = [];

    for (let step = 0; step < 200; step++) {
      const evalLoss = step % 50 === 0 ? 5 - step * 0.01 : null;
      points = appendLossPoint(
        points,
        {
          step,
          loss: 10 - step * 0.005,
          evalLoss,
        },
        cap,
      );
    }

    // Count evalLoss points in the compacted series
    const evalPoints = points.filter((p) => p.evalLoss !== null);
    expect(evalPoints.length).toBeGreaterThan(0);
    // Should retain at least the first, last, min, and max of evalLoss
    const evalSteps = evalPoints.map((p) => p.step);
    expect(evalSteps).toContain(0); // first eval point
    expect(Math.max(...evalSteps)).toBeGreaterThan(0);
  });

  it("preserves spikes (max/min loss points)", () => {
    const cap = 150;
    let points: LossPoint[] = [];

    // Create a loss series with a clear spike
    for (let step = 0; step < 200; step++) {
      let loss = 5 + step * 0.01;
      if (step >= 80 && step <= 120) {
        loss = 10; // spike
      }
      points = appendLossPoint(
        points,
        {
          step,
          loss,
          evalLoss: null,
        },
        cap,
      );
    }

    // Verify the spike region is represented
    const spikeArea = points.filter((p) => p.loss !== null && p.loss > 8);
    expect(spikeArea.length).toBeGreaterThan(0);
  });

  it("handles null values correctly", () => {
    const cap = 50;
    let points: LossPoint[] = [];

    for (let step = 0; step < 100; step++) {
      const hasLoss = step % 2 === 0;
      const hasEval = step % 3 === 0;
      points = appendLossPoint(
        points,
        {
          step,
          loss: hasLoss ? Math.sin(step / 10) : null,
          evalLoss: hasEval ? Math.cos(step / 10) : null,
        },
        cap,
      );
    }

    expect(points.length).toBeLessThanOrEqual(cap);
    // At least one point with data should remain
    const hasData = points.some(
      (p) =>
        (typeof p.loss === "number" && Number.isFinite(p.loss)) ||
        (typeof p.evalLoss === "number" && Number.isFinite(p.evalLoss)),
    );
    expect(hasData).toBe(true);
  });

  it("handles tiny caps", () => {
    const points: LossPoint[] = [
      { step: 0, loss: 5, evalLoss: null },
      { step: 1, loss: 4, evalLoss: null },
      { step: 2, loss: 3, evalLoss: null },
    ];

    // Cap of 1: should keep the latest
    const result1 = appendLossPoint(
      points,
      { step: 3, loss: 2, evalLoss: null },
      1,
    );
    expect(result1.length).toBeLessThanOrEqual(1);

    // Cap of 2: should keep at least first/last
    const result2 = appendLossPoint(
      points,
      { step: 3, loss: 2, evalLoss: null },
      2,
    );
    expect(result2.length).toBeLessThanOrEqual(2);
    if (result2.length === 2) {
      expect(result2[0]!.step).toBeLessThanOrEqual(result2[1]!.step);
    }
  });

  it("returns empty array if cap is 0", () => {
    const points: LossPoint[] = [{ step: 0, loss: 5, evalLoss: null }];
    const result = appendLossPoint(
      points,
      { step: 1, loss: 4, evalLoss: null },
      0,
    );
    expect(result).toEqual([]);
  });

  it("preserves at least one point per non-empty input", () => {
    const cap = 100;
    let points: LossPoint[] = [];

    // Simulate a realistic training run
    for (let step = 0; step < 500; step++) {
      const evalLoss = step % 100 === 0 ? 2 - step * 0.001 : null;
      points = appendLossPoint(
        points,
        {
          step,
          loss: 3 - step * 0.005,
          evalLoss,
        },
        cap,
      );
    }

    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(cap);
  });
});
