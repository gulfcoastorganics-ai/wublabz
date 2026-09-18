import type { SceneQuantize } from '../lib/playback/transportSnapshot.js';
import { validateTimelineEvents } from '../lib/producer/ArrangementReconstructionEngine.js';
import type { TimelineEventV2 } from '../lib/producer/types.js';

export const WUBLABZ_EVENT_TYPES = [
  'HEARTBEAT',
  'TIMELINE_LOAD',
  'TRANSPORT_PLAY',
  'TRANSPORT_PAUSE',
  'TRANSPORT_STOP',
  'TRANSPORT_SEEK',
  'STEM_MUTE',
  'STEM_SOLO',
  'STEM_GAIN',
  'EFFECT_TOGGLE',
  'MACRO_TRIGGER',
  'MACRO_SET_VALUE',
  'SCENE_TRIGGER',
  'EMERGENCY_STOP',
  'ENGINE_STATUS',
  'EVENT_REJECTED'
] as const;

export const WUBLABZ_INTENTS = [
  'HEARTBEAT',
  'TIMELINE_LOAD',
  'TRANSPORT_PLAY',
  'TRANSPORT_PAUSE',
  'TRANSPORT_STOP',
  'TRANSPORT_SEEK',
  'STEM_MUTE',
  'STEM_SOLO',
  'STEM_GAIN',
  'EFFECT_TOGGLE',
  'MACRO_TRIGGER',
  'MACRO_SET_VALUE',
  'SCENE_TRIGGER',
  'EMERGENCY_STOP'
] as const;

export const SCENE_QUANTIZE_VALUES = ['immediate', 'nextBeat', 'nextBar', 'nextPhrase'] as const;

export type WubLabzEventType = typeof WUBLABZ_EVENT_TYPES[number];
export type WubLabzIntent = typeof WUBLABZ_INTENTS[number];

export interface EventRejectedPayload {
  originalType: string;
  reason: string;
  suggestedAction: string;
  timestamp: number;
}

export interface HeartbeatPayload extends Record<string, unknown> {
  clientSent?: number;
  serverReceived?: number;
}

export interface TimelineLoadPayload {
  events: TimelineEventV2[];
  bpm?: number;
}

export interface TransportSeekPayload {
  positionSeconds: number;
}

export interface StemControlPayload {
  stemId: string;
  value?: number; // Used for GAIN (0-1)
}

export interface EffectTogglePayload {
  effectId: string;
  active?: boolean; // If omitted, toggle
}

export interface MacroTriggerPayload {
  macroId: string;
  intensity?: number;
}

export interface MacroSetValuePayload {
  macroId: string;
  value: number;
}

export interface SceneTriggerPayload {
  sceneId: string;
  quantize?: SceneQuantize;
}

export type EmergencyStopPayload = Record<string, unknown>;

export type ValidatedWubLabzEvent =
  | { type: 'HEARTBEAT'; source: string; timestamp?: number; clientId?: string; payload: HeartbeatPayload }
  | { type: 'TIMELINE_LOAD'; source: string; timestamp?: number; clientId?: string; payload: TimelineLoadPayload }
  | { type: 'TRANSPORT_PLAY'; source: string; timestamp?: number; clientId?: string; payload: Record<string, never> }
  | { type: 'TRANSPORT_PAUSE'; source: string; timestamp?: number; clientId?: string; payload: Record<string, never> }
  | { type: 'TRANSPORT_STOP'; source: string; timestamp?: number; clientId?: string; payload: Record<string, never> }
  | { type: 'TRANSPORT_SEEK'; source: string; timestamp?: number; clientId?: string; payload: TransportSeekPayload }
  | { type: 'STEM_MUTE'; source: string; timestamp?: number; clientId?: string; payload: StemControlPayload }
  | { type: 'STEM_SOLO'; source: string; timestamp?: number; clientId?: string; payload: StemControlPayload }
  | { type: 'STEM_GAIN'; source: string; timestamp?: number; clientId?: string; payload: Required<StemControlPayload> }
  | { type: 'EFFECT_TOGGLE'; source: string; timestamp?: number; clientId?: string; payload: EffectTogglePayload }
  | { type: 'MACRO_TRIGGER'; source: string; timestamp?: number; clientId?: string; payload: MacroTriggerPayload }
  | { type: 'MACRO_SET_VALUE'; source: string; timestamp?: number; clientId?: string; payload: MacroSetValuePayload }
  | { type: 'SCENE_TRIGGER'; source: string; timestamp?: number; clientId?: string; payload: SceneTriggerPayload }
  | { type: 'EMERGENCY_STOP'; source: string; timestamp?: number; clientId?: string; payload: EmergencyStopPayload }
  | { type: 'ENGINE_STATUS'; source: string; timestamp?: number; clientId?: string; payload: any }
  | { type: 'EVENT_REJECTED'; source: string; timestamp?: number; clientId?: string; payload: EventRejectedPayload };

export type ProtocolValidationResult =
  | { success: true; event: ValidatedWubLabzEvent }
  | { success: false; rejection: EventRejectedPayload };

type PayloadValidationResult<T> =
  | { success: true; payload: T }
  | { success: false; reason: string; suggestedAction?: string };

const DEFAULT_PROTOCOL_ACTION = 'Send a valid WubLabz protocol event';

export function createProtocolRejection(
  originalType: string,
  reason: string,
  suggestedAction: string = DEFAULT_PROTOCOL_ACTION
): EventRejectedPayload {
  return {
    originalType,
    reason,
    suggestedAction,
    timestamp: Date.now()
  };
}

export function parseAndValidateInboundEvent(rawMessage: string): ProtocolValidationResult {
  try {
    return validateInboundEvent(JSON.parse(rawMessage));
  } catch {
    return {
      success: false,
      rejection: createProtocolRejection('UNKNOWN', 'Malformed JSON')
    };
  }
}

export function validateInboundEvent(candidate: unknown): ProtocolValidationResult {
  if (!isRecord(candidate)) {
    return {
      success: false,
      rejection: createProtocolRejection('UNKNOWN', 'Event must be a JSON object')
    };
  }

  const originalType = getOriginalType(candidate);

  if (typeof candidate.type !== 'string' || typeof candidate.source !== 'string') {
    return {
      success: false,
      rejection: createProtocolRejection(originalType, 'Missing event type or source')
    };
  }

  if (!isWubLabzEventType(candidate.type)) {
    return {
      success: false,
      rejection: createProtocolRejection(candidate.type, 'Unknown event type', 'Use a supported WubLabz protocol event type')
    };
  }

  if (candidate.timestamp !== undefined && !isFiniteNumber(candidate.timestamp)) {
    return {
      success: false,
      rejection: createProtocolRejection(candidate.type, 'Event timestamp must be a number')
    };
  }

  const base = {
    source: candidate.source,
    ...(candidate.timestamp !== undefined ? { timestamp: candidate.timestamp } : {}),
    ...(typeof candidate.clientId === 'string' ? { clientId: candidate.clientId } : {})
  };

  const payload = candidate.payload || {};

  switch (candidate.type) {
    case 'HEARTBEAT': {
      const result = validateHeartbeatPayload(payload);
      return result.success
        ? { success: true, event: { ...base, type: candidate.type, payload: result.payload } as ValidatedWubLabzEvent }
        : rejectPayload(candidate.type, result);
    }
    case 'TIMELINE_LOAD': {
      const result = validateTimelineLoadPayload(payload);
      return result.success
        ? { success: true, event: { ...base, type: candidate.type, payload: result.payload } as ValidatedWubLabzEvent }
        : rejectPayload(candidate.type, result);
    }

    case 'ENGINE_STATUS':
        return { success: true, event: { ...base, type: candidate.type, payload } as ValidatedWubLabzEvent };
    
    case 'EVENT_REJECTED':
        return { success: true, event: { ...base, type: candidate.type, payload: payload as EventRejectedPayload } as ValidatedWubLabzEvent };

    case 'TRANSPORT_PLAY':
    case 'TRANSPORT_PAUSE':
    case 'TRANSPORT_STOP':
      return { success: true, event: { ...base, type: candidate.type, payload: {} } as ValidatedWubLabzEvent };
    
    case 'TRANSPORT_SEEK': {
        if (!isRecord(payload) || !isFiniteNumber(payload.positionSeconds)) {
            return { success: false, rejection: createProtocolRejection(candidate.type, 'positionSeconds is required') };
        }
        return { success: true, event: { ...base, type: candidate.type, payload: { positionSeconds: payload.positionSeconds } } as ValidatedWubLabzEvent };
    }

    case 'STEM_MUTE':
    case 'STEM_SOLO': {
        if (!isRecord(payload) || typeof payload.stemId !== 'string') {
            return { success: false, rejection: createProtocolRejection(candidate.type, 'stemId is required') };
        }
        return { success: true, event: { ...base, type: candidate.type, payload: { stemId: payload.stemId } } as ValidatedWubLabzEvent };
    }

    case 'STEM_GAIN': {
        if (!isRecord(payload) || typeof payload.stemId !== 'string' || !isFiniteNumber(payload.value)) {
            return { success: false, rejection: createProtocolRejection(candidate.type, 'stemId and numeric value are required') };
        }
        return { success: true, event: { ...base, type: candidate.type, payload: { stemId: payload.stemId, value: payload.value } } as ValidatedWubLabzEvent };
    }

    case 'EFFECT_TOGGLE': {
        if (!isRecord(payload) || typeof payload.effectId !== 'string') {
            return { success: false, rejection: createProtocolRejection(candidate.type, 'effectId is required') };
        }
        return { success: true, event: { ...base, type: candidate.type, payload: { effectId: payload.effectId, active: payload.active } } as ValidatedWubLabzEvent };
    }

    case 'MACRO_TRIGGER': {
        if (!isRecord(payload) || typeof payload.macroId !== 'string') {
            return { success: false, rejection: createProtocolRejection(candidate.type, 'macroId is required') };
        }
        return { success: true, event: { ...base, type: candidate.type, payload: { macroId: payload.macroId, intensity: payload.intensity } } as ValidatedWubLabzEvent };
    }

    case 'MACRO_SET_VALUE': {
        if (!isRecord(payload) || typeof payload.macroId !== 'string' || !isFiniteNumber(payload.value)) {
            return { success: false, rejection: createProtocolRejection(candidate.type, 'macroId and numeric value are required') };
        }
        return { success: true, event: { ...base, type: candidate.type, payload: { macroId: payload.macroId, value: payload.value } } as ValidatedWubLabzEvent };
    }

    case 'SCENE_TRIGGER': {
      const result = validateSceneTriggerPayload(payload);
      return result.success
        ? { success: true, event: { ...base, type: candidate.type, payload: result.payload } as ValidatedWubLabzEvent }
        : rejectPayload(candidate.type, result);
    }
    case 'EMERGENCY_STOP': {
      return { success: true, event: { ...base, type: candidate.type, payload: {} } as ValidatedWubLabzEvent };
    }
    default:
        return { success: false, rejection: createProtocolRejection(candidate.type, 'Unsupported event type') };
  }
}

function validateTimelineLoadPayload(payload: unknown): PayloadValidationResult<TimelineLoadPayload> {
  if (!isRecord(payload) || !Array.isArray(payload.events) || payload.events.length === 0) {
    return { success: false, reason: 'TIMELINE_LOAD payload.events must be a non-empty array' };
  }

  if (payload.bpm !== undefined && (!isFiniteNumber(payload.bpm) || payload.bpm < 20 || payload.bpm > 400)) {
    return { success: false, reason: 'TIMELINE_LOAD payload.bpm must be between 20 and 400' };
  }

  for (let index = 0; index < payload.events.length; index += 1) {
    const event = payload.events[index];
    if (
      !isRecord(event) ||
      typeof event.id !== 'string' ||
      typeof event.type !== 'string' ||
      typeof event.sourceId !== 'string' ||
      typeof event.sectionId !== 'string' ||
      typeof event.enabled !== 'boolean' ||
      !isRecord(event.payload)
    ) {
      return { success: false, reason: `TIMELINE_LOAD payload.events[${index}] has an invalid event shape` };
    }
  }

  try {
    const events = validateTimelineEvents(payload.events as TimelineEventV2[]);
    return {
      success: true,
      payload: {
        events,
        ...(payload.bpm !== undefined ? { bpm: payload.bpm } : {})
      }
    };
  } catch (error) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : 'TIMELINE_LOAD contains invalid timeline events'
    };
  }
}

function validateHeartbeatPayload(payload: unknown): PayloadValidationResult<HeartbeatPayload> {
  if (!isRecord(payload)) {
    return { success: false, reason: 'HEARTBEAT payload must be an object' };
  }
  if (payload.clientSent !== undefined && !isFiniteNumber(payload.clientSent)) {
    return { success: false, reason: 'HEARTBEAT payload.clientSent must be a number' };
  }
  return { success: true, payload: payload as HeartbeatPayload };
}

function validateSceneTriggerPayload(payload: unknown): PayloadValidationResult<SceneTriggerPayload> {
  if (!isRecord(payload)) {
    return { success: false, reason: 'SCENE_TRIGGER payload must be an object' };
  }
  const sceneId = payload.sceneId;
  if (typeof sceneId !== 'string') {
    return { success: false, reason: 'SCENE_TRIGGER payload.sceneId must be a string' };
  }
  const quantize = payload.quantize;
  if (quantize !== undefined && !isSceneQuantize(quantize)) {
    return { success: false, reason: 'SCENE_TRIGGER payload.quantize is invalid' };
  }
  return {
    success: true,
    payload: {
      sceneId,
      ...(quantize !== undefined ? { quantize } : {})
    }
  };
}

function rejectPayload<T extends PayloadValidationResult<unknown> & { success: false }>(
  originalType: string,
  result: T
): ProtocolValidationResult {
  return {
    success: false,
    rejection: createProtocolRejection(originalType, result.reason, result.suggestedAction)
  };
}

function getOriginalType(candidate: Record<string, unknown>): string {
  return typeof candidate.type === 'string' ? candidate.type : 'UNKNOWN';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWubLabzEventType(value: string): value is WubLabzEventType {
  return (WUBLABZ_EVENT_TYPES as readonly string[]).includes(value as any);
}

function isSceneQuantize(value: unknown): value is SceneQuantize {
  return typeof value === 'string' && (SCENE_QUANTIZE_VALUES as readonly string[]).includes(value as any);
}
