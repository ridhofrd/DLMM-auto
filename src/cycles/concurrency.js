export let _managementBusy = false;
export let _screeningBusy = false;
export let _screeningLastTriggered = 0;
export let _pollTriggeredAt = 0;

export const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

export function isManagementBusy() { return _managementBusy; }
export function setManagementBusy(val) { _managementBusy = val; }

export function isScreeningBusy() { return _screeningBusy; }
export function setScreeningBusy(val) { _screeningBusy = val; }

export function getScreeningLastTriggered() { return _screeningLastTriggered; }
export function setScreeningLastTriggered(val) { _screeningLastTriggered = val; }

export function getPollTriggeredAt() { return _pollTriggeredAt; }
export function setPollTriggeredAt(val) { _pollTriggeredAt = val; }
