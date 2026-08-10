import type { CameraState } from './types';

/**
 * The alarm panel, in the card's own words.
 *
 * Without this the word "sécurité" is not earned: the card could show you a
 * person at the door and offer nothing to do about it. Arming is the one action
 * a security dashboard is opened for that is not "look", and it is the one the
 * card had no way to express.
 */

export interface ArmAction {
  id: string;
  label: string;
  service: string;
  /** Home Assistant's `supported_features` bit, or 0 for the always-there one. */
  feature: number;
}

/** `alarm_control_panel` feature bits, as Home Assistant defines them. */
const ARM_HOME = 1;
const ARM_AWAY = 2;
const ARM_NIGHT = 4;
const ARM_VACATION = 32;

/**
 * Ordered by how far from home they put you, which is how people think about
 * them — and it puts the two everyday ones first on a phone.
 */
export const ARM_ACTIONS: ArmAction[] = [
  { id: 'disarm', label: 'Désarmer', service: 'alarm_disarm', feature: 0 },
  { id: 'home', label: 'Présent', service: 'alarm_arm_home', feature: ARM_HOME },
  { id: 'night', label: 'Nuit', service: 'alarm_arm_night', feature: ARM_NIGHT },
  { id: 'away', label: 'Absent', service: 'alarm_arm_away', feature: ARM_AWAY },
  { id: 'vacation', label: 'Vacances', service: 'alarm_arm_vacation', feature: ARM_VACATION },
];

export interface AlarmReading {
  /** The raw Home Assistant state. */
  state: string;
  label: string;
  /** Which chart colour says it, reusing the legend rather than inventing one. */
  tone: CameraState;
  armed: boolean;
  /** Mid-transition: the countdown is running and nothing should be offered. */
  busy: boolean;
}

const LABELS: Record<string, { label: string; tone: CameraState; armed: boolean }> = {
  disarmed: { label: 'Désarmé', tone: 'nominal', armed: false },
  armed_home: { label: 'Armé — présent', tone: 'motion', armed: true },
  armed_night: { label: 'Armé — nuit', tone: 'motion', armed: true },
  armed_away: { label: 'Armé — absent', tone: 'motion', armed: true },
  armed_vacation: { label: 'Armé — vacances', tone: 'motion', armed: true },
  armed_custom_bypass: { label: 'Armé — partiel', tone: 'motion', armed: true },
  arming: { label: 'Armement…', tone: 'motion', armed: true },
  pending: { label: 'Entrée…', tone: 'alert', armed: true },
  disarming: { label: 'Désarmement…', tone: 'motion', armed: true },
  triggered: { label: 'ALARME', tone: 'alert', armed: true },
};

export function readAlarm(stateObj: any): AlarmReading | undefined {
  if (!stateObj || typeof stateObj.state !== 'string') return undefined;
  const state = stateObj.state;
  if (state === 'unavailable' || state === 'unknown') {
    return { state, label: 'Alarme indisponible', tone: 'offline', armed: false, busy: true };
  }
  const known = LABELS[state];
  if (!known) return { state, label: state, tone: 'offline', armed: false, busy: true };
  return { ...known, state, busy: state.endsWith('ing') || state === 'pending' };
}

/** The actions this particular panel actually offers. */
export function actionsFor(stateObj: any): ArmAction[] {
  const features = Number(stateObj?.attributes?.supported_features ?? 0);
  return ARM_ACTIONS.filter((a) => a.feature === 0 || (features & a.feature) !== 0);
}

/**
 * Whether a code has to be typed for this action.
 *
 * Two separate attributes decide it and they disagree on purpose: `code_format`
 * says a code exists at all, `code_arm_required` says arming is exempt from it.
 * Getting this wrong in either direction is bad — a code box on a panel that
 * has none is confusing, and no box on one that needs it makes the button
 * silently do nothing.
 */
export function needsCode(stateObj: any, action: ArmAction): boolean {
  const format = stateObj?.attributes?.code_format;
  if (!format) return false;
  if (action.id === 'disarm') return true;
  return stateObj?.attributes?.code_arm_required !== false;
}

export const codeIsNumeric = (stateObj: any): boolean =>
  stateObj?.attributes?.code_format === 'number';
