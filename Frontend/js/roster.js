/** Shared demo roster, so the Employer and Carpool views load it once between them. */

import { getJSON } from "./api.js";

let roster = [];
const listeners = new Set();

export function current() {
  return roster;
}

export function isLoaded() {
  return roster.length > 0;
}

export function onChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export async function load() {
  const data = await getJSON("/api/v2/demo/roster");
  roster = data.employees;
  listeners.forEach((callback) => callback(roster));
  return roster;
}

export function describe() {
  if (!roster.length) return "No roster loaded.";
  const withoutVehicle = roster.filter((employee) => !employee.has_vehicle).length;
  return `${roster.length} employees · ${withoutVehicle} without a vehicle`;
}

/** Shape the roster for the /roster/gaps and /carpool/plan endpoints. */
export function toPayload(useOwnShifts) {
  return roster.map((employee) => ({
    employee_ref: employee.employee_ref,
    origin_zone_id: employee.origin_zone_id,
    has_vehicle: employee.has_vehicle,
    shift_start: useOwnShifts ? employee.shift_start : null,
    shift_end: useOwnShifts ? employee.shift_end : null,
  }));
}
