import { getAccountMeta, isCooldownExpired } from "./state.js";

export function listAccountsWithMeta(accounts, state) {
  return accounts.map((acc) => ({
    ...acc,
    meta: getAccountMeta(state, acc.id),
  }));
}

export function isSelectable(account, meta) {
  if (account.disabled) return false;
  if (meta.state === "disabled" || meta.state === "invalid") return false;
  if ((meta.state === "exhausted" || meta.state === "cooldown") && !isCooldownExpired(meta)) {
    return false;
  }
  return true;
}

export function selectNext(accounts, state, config, { excludeId } = {}) {
  const candidates = accounts
    .filter((acc) => acc.id !== excludeId)
    .map((acc) => ({ account: acc, meta: getAccountMeta(state, acc.id) }))
    .filter(({ account, meta }) => isSelectable(account, meta));

  if (candidates.length === 0) return null;

  const strategy = config.selection_strategy || "round-robin";

  if (strategy === "priority") {
    candidates.sort((a, b) => {
      const pa = a.account.priority ?? 100;
      const pb = b.account.priority ?? 100;
      if (pa !== pb) return pa - pb;
      return (a.meta.last_used_at || "").localeCompare(b.meta.last_used_at || "");
    });
    return candidates[0].account;
  }

  if (strategy === "least-recently-used") {
    candidates.sort((a, b) => (a.meta.last_used_at || "").localeCompare(b.meta.last_used_at || ""));
    return candidates[0].account;
  }

  // round-robin: after active id in list order
  const order = accounts.map((a) => a.id).filter((id) => id !== excludeId);
  const selectableIds = new Set(candidates.map((c) => c.account.id));
  const startIdx = state.active_account_id ? order.indexOf(state.active_account_id) : -1;

  for (let i = 1; i <= order.length; i++) {
    const id = order[(startIdx + i) % order.length];
    if (selectableIds.has(id)) {
      return candidates.find((c) => c.account.id === id).account;
    }
  }

  return candidates[0].account;
}

export function markAccount(state, accountId, patch) {
  const meta = getAccountMeta(state, accountId);
  Object.assign(meta, patch);
  return meta;
}
