import json

with open('lessons.json', 'r') as f:
    data = json.load(f)

perf = [p for p in data.get('performance', []) if 'pnl_pct' in p]
perf.sort(key=lambda x: x['pnl_pct'])

print('Top 5 Worst Trades:')
for p in perf[:5]:
    print(f"Pool: {p.get('pool_name')}, PnL: {p.get('pnl_pct')}%, Date: {p.get('recorded_at')}, Reason: {p.get('close_reason')}, Held: {p.get('minutes_held')} mins")

print('\nTop 5 Latest Trades:')
perf_latest = sorted(perf, key=lambda x: x.get('recorded_at', ''), reverse=True)
for p in perf_latest[:5]:
    print(f"Pool: {p.get('pool_name')}, PnL: {p.get('pnl_pct')}%, Date: {p.get('recorded_at')}, Reason: {p.get('close_reason')}, Held: {p.get('minutes_held')} mins")
