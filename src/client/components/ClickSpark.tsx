import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";

interface Spark {
  x: number;
  y: number;
  angle: number;
  startedAt: number;
}

const SPARK_COUNT = 8;
const DURATION_MS = 420;

/**
 * A tiny, dependency-free click celebration for explicitly marked actions.
 * Add `data-spark` to a button or link; ordinary navigation and controls stay
 * quiet. The fixed canvas exists only while sparks are animating and is fully
 * disabled for reduced-motion users.
 */
export function ClickSpark() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let sparks: Spark[] = [];
    let frame = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (now: number) => {
      frame = 0;
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      sparks = sparks.filter((spark) => now - spark.startedAt < DURATION_MS);
      context.lineCap = "round";
      context.lineWidth = 2;

      for (const spark of sparks) {
        const progress = Math.min((now - spark.startedAt) / DURATION_MS, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const distance = 9 + eased * 25;
        const length = 7 * (1 - progress);
        const cos = Math.cos(spark.angle);
        const sin = Math.sin(spark.angle);
        context.globalAlpha = 1 - progress;
        context.strokeStyle = "#e58a67";
        context.beginPath();
        context.moveTo(spark.x + cos * distance, spark.y + sin * distance);
        context.lineTo(
          spark.x + cos * (distance + length),
          spark.y + sin * (distance + length)
        );
        context.stroke();
      }

      context.globalAlpha = 1;
      if (sparks.length > 0) frame = requestAnimationFrame(draw);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest("[data-spark]") : null;
      if (!target || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") {
        return;
      }
      const startedAt = performance.now();
      for (let index = 0; index < SPARK_COUNT; index += 1) {
        sparks.push({
          x: event.clientX,
          y: event.clientY,
          angle: (Math.PI * 2 * index) / SPARK_COUNT,
          startedAt,
        });
      }
      if (!frame) frame = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100]"
    />
  );
}
