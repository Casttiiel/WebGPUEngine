import { z } from 'zod';
import type { BrowserSession } from './browser.ts';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Punto en pantalla: coordenadas relativas al canvas (px CSS), posición de mundo o entidad. */
export const TargetSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    world: vec3.optional().describe('World position, projected through the main camera'),
    entity: z.string().optional().describe('Entity name or id; uses its world position'),
  })
  .describe(
    'Canvas-relative {x,y} in CSS px (canvas is 1280x720), or {world:[x,y,z]}, or {entity:"Name"}',
  );

const button = z.enum(['left', 'right', 'middle']).optional();
const modifiers = z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).optional();

export const InputActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ...TargetSchema.shape, button, modifiers }),
  z.object({ type: z.literal('dblclick'), ...TargetSchema.shape, button, modifiers }),
  z.object({ type: z.literal('move'), ...TargetSchema.shape, steps: z.number().int().optional() }),
  z.object({ type: z.literal('down'), ...TargetSchema.shape, button }),
  z.object({ type: z.literal('up'), ...TargetSchema.shape, button }),
  z.object({
    type: z.literal('key'),
    key: z.string().describe('Playwright key name: "KeyW", "Space", "Escape", "Digit1", "Shift"…'),
    action: z.enum(['press', 'down', 'up']).optional(),
    holdMs: z.number().optional().describe('For press: keep the key down this long (real time)'),
  }),
  z.object({ type: z.literal('type'), text: z.string() }),
  z.object({
    type: z.literal('wheel'),
    deltaY: z.number(),
    deltaX: z.number().optional(),
    ...TargetSchema.shape,
  }),
  z.object({
    type: z.literal('drag'),
    from: TargetSchema,
    to: TargetSchema,
    button,
    steps: z.number().int().optional(),
  }),
  z.object({ type: z.literal('wait'), ms: z.number() }),
  z.object({
    type: z.literal('wait_frames'),
    frames: z
      .number()
      .int()
      .describe('Simulated frames. If paused, steps them; otherwise waits for them.'),
  }),
]);

export type InputAction = z.infer<typeof InputActionSchema>;
type Target = z.infer<typeof TargetSchema>;

async function resolveTarget(
  session: BrowserSession,
  t: Target,
  required: boolean,
): Promise<{ x: number; y: number } | null> {
  const origin = await session.canvasOrigin();
  if (t.world || t.entity !== undefined) {
    const ref = t.world ?? t.entity;
    const p = await session.call<{ x: number; y: number; visible: boolean }>('worldToScreen', ref);
    if (!p.visible)
      throw new Error(
        `Target ${JSON.stringify(ref)} is not visible on screen (projected to ${p.x},${p.y})`,
      );
    return { x: origin.x + p.x, y: origin.y + p.y };
  }
  if (t.x !== undefined && t.y !== undefined) return { x: origin.x + t.x, y: origin.y + t.y };
  if (required) throw new Error('Input target needs {x,y}, {world} or {entity}');
  return null;
}

export async function waitSimFrames(session: BrowserSession, frames: number): Promise<unknown> {
  const time = await session.call<{ paused: boolean }>('getTimeState');
  return time.paused ? session.call('step', frames) : session.call('waitFrames', frames);
}

export async function performInput(session: BrowserSession, action: InputAction): Promise<string> {
  const page = session.getPage();
  const mouse = page.mouse;
  switch (action.type) {
    case 'click':
    case 'dblclick': {
      const p = (await resolveTarget(session, action, true))!;
      for (const m of action.modifiers ?? []) await page.keyboard.down(m);
      if (action.type === 'click') await mouse.click(p.x, p.y, { button: action.button ?? 'left' });
      else await mouse.dblclick(p.x, p.y, { button: action.button ?? 'left' });
      for (const m of action.modifiers ?? []) await page.keyboard.up(m);
      return `${action.type} ${action.button ?? 'left'} at page(${Math.round(p.x)},${Math.round(p.y)})`;
    }
    case 'move': {
      const p = (await resolveTarget(session, action, true))!;
      await mouse.move(p.x, p.y, { steps: action.steps ?? 1 });
      return `move to page(${Math.round(p.x)},${Math.round(p.y)})`;
    }
    case 'down':
    case 'up': {
      const p = await resolveTarget(session, action, false);
      if (p) await mouse.move(p.x, p.y);
      if (action.type === 'down') await mouse.down({ button: action.button ?? 'left' });
      else await mouse.up({ button: action.button ?? 'left' });
      return `mouse ${action.type} ${action.button ?? 'left'}`;
    }
    case 'key': {
      const kind = action.action ?? 'press';
      if (kind === 'down') await page.keyboard.down(action.key);
      else if (kind === 'up') await page.keyboard.up(action.key);
      else if (action.holdMs) {
        await page.keyboard.down(action.key);
        await new Promise((r) => setTimeout(r, action.holdMs));
        await page.keyboard.up(action.key);
      } else await page.keyboard.press(action.key);
      return `key ${kind} ${action.key}`;
    }
    case 'type':
      await page.keyboard.type(action.text);
      return `typed ${JSON.stringify(action.text)}`;
    case 'wheel': {
      const p = await resolveTarget(session, action, false);
      if (p) await mouse.move(p.x, p.y);
      await mouse.wheel(action.deltaX ?? 0, action.deltaY);
      return `wheel ${action.deltaY}`;
    }
    case 'drag': {
      const a = (await resolveTarget(session, action.from, true))!;
      const b = (await resolveTarget(session, action.to, true))!;
      const btn = action.button ?? 'left';
      await mouse.move(a.x, a.y);
      await mouse.down({ button: btn });
      await mouse.move(b.x, b.y, { steps: action.steps ?? 10 });
      await mouse.up({ button: btn });
      return `drag ${btn} (${Math.round(a.x)},${Math.round(a.y)}) → (${Math.round(b.x)},${Math.round(b.y)})`;
    }
    case 'wait':
      await new Promise((r) => setTimeout(r, action.ms));
      return `waited ${action.ms}ms`;
    case 'wait_frames':
      await waitSimFrames(session, action.frames);
      return `waited ${action.frames} frames`;
  }
}
