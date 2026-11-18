import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  DistanceGrabbable,
  MovementMode,
  PlaneGeometry,
  RayInteractable,
  SphereGeometry,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  World,
  createSystem,
} from '@iwsdk/core';
import * as IWSDK from '@iwsdk/core';

const COLORS = [0xff4d4d, 0x4dd2ff, 0xffd84d];
const PAD_X = [-0.3, 0, 0.3];
const PAD_Y = 0.81;
const PAD_Z = -0.7;
const PAD_RADIUS = 0.15;
const PAD_VISUAL = 0.13;
const DROP_MIN_Y = 0.6;
const DROP_MAX_Y = 1.6;
const START_Y = 1.05;
const START_Z = -0.4;
const LEVEL_SIZES = [6, 9, 12, 15];
const MAX_ORBS = 15;

// How a drop is detected
// ----------------------
// A drop happens when you RELEASE an orb (the SDK's "Pressed" state ends).
// Merely pointing the ray at an orb, or clicking it without moving it, is not
// a drop: a drop only counts if the orb ended up more than ARM_DISTANCE away
// from where its previous drop was resolved (or from where it started).
// If the SDK never reports the pressed state, we fall back to "the orb has
// stayed still for STILL_MS".
const ARM_DISTANCE = 0.04;
const RELEASE_DELAY_MS = 150;
const STILL_MS = 250;
const CALM_RADIUS = 0.02;
// How close (in radians, seen from the player's eyes) an orb has to look to a
// pad to count as dropped on it. Distance-grab keeps the orb on the ray, so it
// often floats in front of the pad while looking like it is on it.
const VISUAL_ANGLE = 0.15;

const PressedComponent = (IWSDK as any).Pressed;
let pressedSeen = false;

interface Orb {
  mesh: Mesh;
  entity: any;
  colorIndex: number;
  sorted: boolean;
  active: boolean;
  wasHeld: boolean;
  dropAt: number;
  still: number;
  anchor: Vector3;
  calm: Vector3;
}

const orbs: Orb[] = [];
const pads: Mesh[] = [];
const padPulse = [0, 0, 0];
let level = 0;
let mistakes = 0;
let startedAt = 0;
let finishedAt = 0;
let nextLevelAt = 0;
let lastHud = 0;
let gameOver = false;
let totalSecs = 0;
let totalMistakes = 0;
let lastNow = 0;
let hudCanvas: HTMLCanvasElement | null = null;
let hudCtx: CanvasRenderingContext2D | null = null;
let hudTexture: CanvasTexture | null = null;

// ---------------------------------------------------------------------------
// Sound effects, generated in code (no audio files). Press M to mute/unmute.
// ---------------------------------------------------------------------------
let audioCtx: AudioContext | null = null;
let muted = false;

function getAudio(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor() as AudioContext;
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number): void {
  if (muted) return;
  const ctx = getAudio();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch {
    // Sound is a bonus; never let it break the game.
  }
}

function playCorrect(): void {
  tone(659.25, 0, 0.18, 'sine', 0.25);
  tone(880, 0.09, 0.3, 'sine', 0.25);
}

function playWrong(): void {
  tone(196, 0, 0.25, 'sawtooth', 0.1);
  tone(155.56, 0.12, 0.3, 'sawtooth', 0.1);
}

function playLevelDone(): void {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.3 + i * 0.12, 0.3, 'triangle', 0.22));
}

function shuffle(items: number[]): number[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function drawHud(lines: string[], accent: string): void {
  if (!hudCtx || !hudCanvas || !hudTexture) return;
  const w = hudCanvas.width;
  const h = hudCanvas.height;
  hudCtx.clearRect(0, 0, w, h);
  hudCtx.fillStyle = 'rgba(20,24,34,0.88)';
  hudCtx.fillRect(0, 0, w, h);
  hudCtx.fillStyle = accent;
  hudCtx.fillRect(0, 0, w, 14);
  hudCtx.fillStyle = '#ffffff';
  hudCtx.textAlign = 'center';
  hudCtx.font = 'bold 72px sans-serif';
  hudCtx.fillText(lines[0], w / 2, 120);
  hudCtx.font = '52px sans-serif';
  lines.slice(1).forEach((text, i) => hudCtx!.fillText(text, w / 2, 210 + i * 70));
  hudTexture.needsUpdate = true;
}

function startLevel(n: number): void {
  level = n;
  const count = LEVEL_SIZES[n];
  mistakes = 0;
  finishedAt = 0;
  startedAt = performance.now();
  const order = shuffle(Array.from({ length: count }, (_, i) => i % 3));
  const perRow = count > 9 ? Math.ceil(count / 2) : count;
  orbs.forEach((orb, i) => {
    orb.sorted = false;
    orb.still = 0;
    orb.wasHeld = false;
    orb.dropAt = 0;
    orb.active = i < count;
    if (!orb.active) {
      orb.mesh.visible = false;
      orb.mesh.position.set(0, -5, 0);
      return;
    }
    orb.colorIndex = order[i];
    const mat = orb.mesh.material as MeshStandardMaterial;
    mat.color.setHex(COLORS[order[i]]);
    mat.emissive.setHex(COLORS[order[i]]);
    mat.emissiveIntensity = 0.35;
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const rowCount = row === 0 ? perRow : count - perRow;
    const x = (col - (rowCount - 1) / 2) * 0.1;
    const y = START_Y + row * 0.1;
    orb.mesh.visible = true;
    orb.mesh.position.set(x, y, START_Z);
    orb.anchor.set(x, y, START_Z);
    orb.calm.set(x, y, START_Z);
  });
}

export function setupPinchSort(world: World): void {
  // Table
  const table = new Mesh(
    new BoxGeometry(1.1, 0.04, 0.7),
    new MeshStandardMaterial({ color: 0x3a3f4b }),
  );
  table.position.set(0, 0.78, -0.62);
  world.createTransformEntity(table);

  // Colored pads
  COLORS.forEach((color, i) => {
    const pad = new Mesh(
      new CylinderGeometry(PAD_VISUAL, PAD_VISUAL, 0.02, 32),
      new MeshStandardMaterial({ color }),
    );
    pad.position.set(PAD_X[i], PAD_Y, PAD_Z);
    world.createTransformEntity(pad);
    pads.push(pad);
  });

  // Score panel
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024;
  hudCanvas.height = 384;
  hudCtx = hudCanvas.getContext('2d');
  hudTexture = new CanvasTexture(hudCanvas);
  const hud = new Mesh(
    new PlaneGeometry(0.8, 0.3),
    new MeshBasicMaterial({ map: hudTexture, transparent: true }),
  );
  hud.position.set(0, 1.3, -0.8);
  world.createTransformEntity(hud);

  // Orbs (all created once, shown or hidden per level)
  for (let i = 0; i < MAX_ORBS; i++) {
    const mesh = new Mesh(
      new SphereGeometry(0.035, 24, 24),
      new MeshStandardMaterial({ color: 0xffffff }),
    );
    const entity = world.createTransformEntity(mesh);
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });
    orbs.push({
      mesh,
      entity,
      colorIndex: 0,
      sorted: false,
      active: false,
      wasHeld: false,
      dropAt: 0,
      still: 0,
      anchor: new Vector3(),
      calm: new Vector3(),
    });
  }

  console.log('PINCHSORT pressed-state tracking available:', !!PressedComponent);
  // Browsers only allow sound after a click, tap or key press, so wake the
  // audio up on the first one. Press M to mute or unmute.
  ['pointerdown', 'touchstart', 'keydown'].forEach((name) =>
    window.addEventListener(name, () => void getAudio(), { passive: true }),
  );
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'm' || e.key === 'M') muted = !muted;
  });

  lastNow = performance.now();
  startLevel(0);
  enableMouseDrag(world);
  enableMouseDrop(world);
  window.addEventListener('pointerdown', () => {
    if (gameOver) {
      gameOver = false;
      totalSecs = 0;
      totalMistakes = 0;
      startLevel(0);
    }
  });
}

function sortOrb(orb: Orb, pad: number): void {
  orb.sorted = true;
  orb.mesh.visible = false;
  orb.mesh.position.set(0, -5, 0);
  padPulse[pad] = 1;
  playCorrect();
}

export class PinchSortSystem extends createSystem({}) {
  private headPos = new Vector3();
  private vOrb = new Vector3();
  private vPad = new Vector3();

  // Which pad is this point over? First by position (straight above the pad),
  // then as seen from the player's eyes, so a drop that looks right counts.
  // Returns -1 when the point is not over any pad.
  private padAt(p: Vector3): number {
    let best = -1;
    let bestD = PAD_RADIUS;
    if (p.y > DROP_MIN_Y && p.y < DROP_MAX_Y) {
      for (let j = 0; j < 3; j++) {
        const d = Math.hypot(p.x - PAD_X[j], p.z - PAD_Z);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
    }
    if (best >= 0) return best;

    this.vOrb.copy(p).sub(this.headPos);
    let bestA = VISUAL_ANGLE;
    for (let j = 0; j < 3; j++) {
      this.vPad.set(PAD_X[j], PAD_Y, PAD_Z);
      if (p.distanceTo(this.vPad) > 0.7) continue;
      this.vPad.sub(this.headPos);
      const a = this.vOrb.angleTo(this.vPad);
      if (a < bestA) {
        bestA = a;
        best = j;
      }
    }
    return best;
  }

  // Called once per drop. Counts at most one result per drop, and only if the
  // orb really moved since its previous drop.
  private resolveDrop(orb: Orb): void {
    const p = orb.mesh.position;
    if (p.distanceTo(orb.anchor) <= ARM_DISTANCE) return;
    orb.anchor.copy(p);
    const pad = this.padAt(p);
    if (pad < 0) {
      console.log('DROP-NOT-ON-PAD', 'x', p.x.toFixed(2), 'y', p.y.toFixed(2), 'z', p.z.toFixed(2));
      return;
    }
    if (orb.colorIndex === pad) {
      sortOrb(orb, pad);
      return;
    }
    mistakes++;
    playWrong();
    console.log('MISTAKE', 'orb', orb.colorIndex, 'pad', pad);
  }

  update(): void {
    const now = performance.now();
    const dt = Math.min(now - lastNow, 100);
    lastNow = now;

    padPulse.forEach((value, i) => {
      padPulse[i] = value * 0.9;
      pads[i]?.scale.setScalar(1 + 0.12 * padPulse[i]);
    });

    if (finishedAt > 0) {
      if (level === LEVEL_SIZES.length - 1) {
        if (!gameOver) {
          gameOver = true;
          drawHud(
            [
              'You finished all levels!',
              `Total ${totalSecs}s   Mistakes ${totalMistakes}`,
              'Click to play again',
            ],
            '#ffd84d',
          );
        } else if (now >= nextLevelAt + 30000) {
          gameOver = false;
          totalSecs = 0;
          totalMistakes = 0;
          startLevel(0);
        }
        return;
      }
      if (now >= nextLevelAt) startLevel(level + 1);
      return;
    }

    this.player.head.updateWorldMatrix(true, false);
    this.headPos.setFromMatrixPosition(this.player.head.matrixWorld);

    let remaining = 0;
    for (const orb of orbs) {
      if (!orb.active || orb.sorted) continue;
      const p = orb.mesh.position;

      // Is the orb being held right now? A release starts a short timer, and
      // the drop is judged when it ends.
      const held = PressedComponent ? !!orb.entity.hasComponent(PressedComponent) : false;
      let resolveNow = false;
      if (held) {
        if (!pressedSeen) {
          pressedSeen = true;
          console.log('PRESSED-SEEN');
        }
        orb.wasHeld = true;
        orb.dropAt = 0;
      } else if (orb.wasHeld) {
        orb.wasHeld = false;
        orb.dropAt = now + RELEASE_DELAY_MS;
      }
      if (orb.dropAt > 0 && now >= orb.dropAt) {
        orb.dropAt = 0;
        resolveNow = true;
      }

      // Fallback only if the SDK never reports the pressed state.
      if (p.distanceTo(orb.calm) > CALM_RADIUS) {
        orb.calm.copy(p);
        orb.still = 0;
      } else {
        orb.still += dt;
      }
      if (!pressedSeen && orb.still >= STILL_MS) resolveNow = true;

      if (resolveNow) {
        this.resolveDrop(orb);
        if (orb.sorted) continue;
      }
      remaining++;
    }

    const count = LEVEL_SIZES[level];
    if (remaining === 0) {
      finishedAt = now;
      nextLevelAt = now + 5000;
      playLevelDone();
      const secs = Math.round((now - startedAt) / 1000);
      const last = level === LEVEL_SIZES.length - 1;
      totalSecs += secs;
      totalMistakes += mistakes;
      drawHud(
        [
          'Level complete!',
          `Time ${secs}s   Mistakes ${mistakes}`,
          last ? 'You finished every level!' : 'Next level starting...',
        ],
        '#59d98e',
      );
      return;
    }
    if (now - lastHud > 200) {
      lastHud = now;
      const secs = Math.round((now - startedAt) / 1000);
      drawHud(
        [
          `Pinch Sort - Level ${level + 1}/${LEVEL_SIZES.length}`,
          `Sorted ${count - remaining} / ${count}   Mistakes ${mistakes}`,
          `Time ${secs}s`,
        ],
        '#4dd2ff',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Desktop mouse mode (judges without a headset)
// ---------------------------------------------------------------------------

function getCanvas(w: any): HTMLCanvasElement | null {
  return w.renderer?.domElement ?? (document.querySelector('canvas') as HTMLCanvasElement | null);
}

function enableMouseDrag(world: World): void {
  try {
    const w = world as any;
    const camera = w.camera;
    const canvas = getCanvas(w);
    if (!camera || !canvas) return;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const plane = new Plane(new Vector3(0, 1, 0), -0.86);
    const hit = new Vector3();
    let dragging: Orb | null = null;

    const aim = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
    };

    window.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        if (w.renderer?.xr?.isPresenting) return;
        aim(e);
        const meshes = orbs.filter((o) => o.active && !o.sorted).map((o) => o.mesh);
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length === 0) return;
        dragging = orbs.find((o) => o.mesh === hits[0].object) ?? null;
        if (dragging) dragging.still = 0;
      },
      true,
    );

    window.addEventListener(
      'pointermove',
      (e: PointerEvent) => {
        if (!dragging) return;
        aim(e);
        if (raycaster.ray.intersectPlane(plane, hit)) {
          dragging.mesh.position.set(hit.x, 0.86, hit.z);
        }
      },
      true,
    );

    const release = (): void => {
      dragging = null;
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  } catch (err) {
    alert('Mouse setup error: ' + String(err));
  }
}

function enableMouseDrop(world: World): void {
  try {
    const w = world as any;
    const camera = w.camera;
    const canvas = getCanvas(w);
    if (!camera || !canvas) return;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let held: Orb | null = null;

    window.addEventListener(
      'pointerdown',
      (e: PointerEvent) => {
        held = null;
        if (w.renderer?.xr?.isPresenting) return;
        const r = canvas.getBoundingClientRect();
        pointer.set(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        const meshes = orbs.filter((o) => o.active && !o.sorted).map((o) => o.mesh);
        const hits = raycaster.intersectObjects(meshes, false);
        held = hits.length ? (orbs.find((o) => o.mesh === hits[0].object) ?? null) : null;
      },
      true,
    );

    const drop = (): void => {
      if (w.renderer?.xr?.isPresenting) {
        held = null;
        return;
      }
      if (held) {
        dropOrbScreen(held, camera, canvas);
        held = null;
      }
    };
    window.addEventListener('pointerup', drop, true);
    window.addEventListener('pointercancel', drop, true);
  } catch (err) {
    alert('Drop setup error: ' + String(err));
  }
}

function dropOrbScreen(orb: Orb, camera: any, canvas: HTMLCanvasElement): void {
  if (!orb.active || orb.sorted || finishedAt > 0) return;
  const rect = canvas.getBoundingClientRect();
  const toScreen = (x: number, y: number, z: number) => {
    const v = new Vector3(x, y, z).project(camera);
    return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
  };
  const p = orb.mesh.position;
  const o = toScreen(p.x, p.y, p.z);
  let best = -1;
  let bestD = 1e9;
  for (let j = 0; j < 3; j++) {
    const pp = toScreen(PAD_X[j], PAD_Y + 0.03, PAD_Z);
    const d = Math.hypot(o.x - pp.x, o.y - pp.y);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  const limit = rect.width * 0.07;
  if (best < 0 || bestD > limit) return;
  if (orb.colorIndex === best) {
    sortOrb(orb, best);
  } else if (p.distanceTo(orb.anchor) > ARM_DISTANCE) {
    mistakes++;
    playWrong();
    orb.anchor.copy(p);
  }
}
