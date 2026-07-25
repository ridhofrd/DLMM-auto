import { runManagementCycle, setScreeningTrigger } from "./management.js";
import { runScreeningCycle } from "./screening.js";
import { setManagementTrigger } from "./trailing-confirm.js";

// Wire the triggers to avoid circular dependencies
setScreeningTrigger(runScreeningCycle);
setManagementTrigger(runManagementCycle);

export { runManagementCycle } from "./management.js";
export { runScreeningCycle } from "./screening.js";
export {
  isManagementBusy,
  setManagementBusy,
  isScreeningBusy,
  setScreeningBusy,
  timers,
  getScreeningLastTriggered,
  setScreeningLastTriggered,
  getPollTriggeredAt,
  setPollTriggeredAt
} from "./state.js";
