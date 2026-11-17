import type { GamePhase } from '../types';

export function drawFlightScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  phase: GamePhase,
  multiplier: number,
  elapsedMs: number,
  crashElapsedMs: number,
  nowPerf: number
): void {
  // 1. Deep Aviation Slate Background + Dynamic Altitude Glow
  ctx.fillStyle = '#0B0F18';
  ctx.fillRect(0, 0, width, height);

  const glowColor =
    phase === 'CRASHED'
      ? 'rgba(225, 29, 72, 0.14)'
      : multiplier >= 10
      ? 'rgba(245, 158, 11, 0.16)'
      : multiplier >= 2
      ? 'rgba(139, 92, 246, 0.16)'
      : 'rgba(225, 29, 72, 0.11)';

  const radial = ctx.createRadialGradient(
    width * 0.55,
    height * 0.55,
    20,
    width * 0.55,
    height * 0.55,
    Math.max(width, height) * 0.65
  );
  radial.addColorStop(0, glowColor);
  radial.addColorStop(1, 'rgba(11, 15, 24, 0)');
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, width, height);

  // 2. Aviation Telemetry Grid (scrolls smoothly while flying)
  const padLeft = 44;
  const padBottom = 34;
  const gridStep = 48;
  const scrollX = phase === 'FLYING' ? (elapsedMs * 0.045) % gridStep : 0;
  const scrollY = phase === 'FLYING' ? (elapsedMs * 0.025) % gridStep : 0;

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = padLeft - scrollX; x < width; x += gridStep) {
    if (x < padLeft) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height - padBottom);
  }
  for (let y = height - padBottom + scrollY; y > 0; y -= gridStep) {
    if (y > height - padBottom) continue;
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Axes hairlines
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.beginPath();
  ctx.moveTo(padLeft, 14);
  ctx.lineTo(padLeft, height - padBottom);
  ctx.lineTo(width - 14, height - padBottom);
  ctx.stroke();

  // Subtle Y-axis multiplier markers
  ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  const axisLabels = ['1.0x', '1.5x', '2.0x', '3.0x', '5.0x'];
  for (let i = 0; i < axisLabels.length; i += 1) {
    const y = height - padBottom - (i * (height - padBottom - 40)) / (axisLabels.length - 1);
    ctx.fillText(axisLabels[i], padLeft - 8, y + 3);
  }

  if (phase === 'BETTING') {
    drawAviatorPlane(ctx, padLeft + 24, height - padBottom - 16, -0.05, nowPerf, false);
    return;
  }

  // 3. Trajectory Curve Calculation
  const maxW = width - padLeft - 58;
  const maxH = height - padBottom - 54;

  const tNorm = Math.min(1, elapsedMs / 14000);
  const easeOut = 1 - Math.pow(1 - tNorm, 2.2);
  const bob = phase === 'FLYING' ? Math.sin(nowPerf * 0.004) * 5 * tNorm : 0;

  const endX = padLeft + easeOut * maxW;
  const endY = height - padBottom - easeOut * maxH + bob;
  const ctrlX = padLeft + (endX - padLeft) * 0.58;
  const ctrlY = height - padBottom - (height - padBottom - endY) * 0.16;

  if (phase === 'FLYING') {
    const areaGrad = ctx.createLinearGradient(0, endY, 0, height - padBottom);
    areaGrad.addColorStop(0, 'rgba(244, 63, 94, 0.34)');
    areaGrad.addColorStop(1, 'rgba(244, 63, 94, 0.02)');

    ctx.beginPath();
    ctx.moveTo(padLeft, height - padBottom);
    ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
    ctx.lineTo(endX, height - padBottom);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(244, 63, 94, 0.65)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = '#F43F5E';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(padLeft, height - padBottom);
    ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
    ctx.stroke();
    ctx.restore();

    const dx = endX - ctrlX;
    const dy = endY - ctrlY;
    const angle = Math.atan2(dy, dx);
    drawAviatorPlane(ctx, endX, endY, angle, nowPerf, true);
  } else if (phase === 'CRASHED') {
    const flyProgress = Math.min(1, crashElapsedMs / 850);
    const planeX = endX + flyProgress * 260;
    const planeY = endY - flyProgress * 190;
    if (planeX < width + 80 && planeY > -80) {
      drawAviatorPlane(ctx, planeX, planeY, -0.58, nowPerf, true);
    }
  }
}

export function drawAviatorPlane(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angleRad: number,
  nowPerf: number,
  inFlight: boolean
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleRad);

  if (inFlight) {
    const trailGrad = ctx.createLinearGradient(-44, 0, -14, 0);
    trailGrad.addColorStop(0, 'rgba(255,255,255,0)');
    trailGrad.addColorStop(1, 'rgba(251,113,133,0.55)');
    ctx.strokeStyle = trailGrad;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-42, 2);
    ctx.lineTo(-14, 1);
    ctx.stroke();
  }

  ctx.fillStyle = '#BE123C';
  ctx.beginPath();
  ctx.moveTo(-16, 0);
  ctx.lineTo(-22, -10);
  ctx.lineTo(-12, -8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#E11D48';
  ctx.beginPath();
  ctx.moveTo(-18, 2);
  ctx.quadraticCurveTo(-4, -8, 18, -2);
  ctx.quadraticCurveTo(22, 1, 18, 5);
  ctx.quadraticCurveTo(-4, 8, -18, 2);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.ellipse(2, -4, 6, 3, -0.1, Math.PI, 0);
  ctx.fill();

  ctx.fillStyle = '#FB7185';
  ctx.beginPath();
  ctx.moveTo(-4, 2);
  ctx.lineTo(8, 2);
  ctx.lineTo(2, 10);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#F8FAFC';
  ctx.beginPath();
  ctx.arc(19, 1, 3, 0, Math.PI * 2);
  ctx.fill();

  const propScale = Math.sin(nowPerf * 0.08);
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(21, 1 - 11 * Math.abs(propScale));
  ctx.lineTo(21, 1 + 11 * Math.abs(propScale));
  ctx.stroke();

  ctx.restore();
}
