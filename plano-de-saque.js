/* Plano de saque — motor e painel. Submissão para revisão no beta zz1. */
(() => {
  "use strict";

  const minute = 60_000;
  const day = 1440 * minute;
  const coords = /^\d{1,3}\|\d{1,3}$/;
  const distance = (a, b) => Math.hypot(...a.split("|").map((n, i) => Number(n) - Number(b.split("|")[i])));
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const time = (value) => typeof value === "number" ? value : Date.parse(value);
  const recent = (rows, now) => rows.filter(r => time(r.at) <= now && time(r.at) >= now - 21 * day);
  const formatters = new Map();
  function dateFormat(at, zone, date) {
    const key = zone + "/" + date;
    if (!formatters.has(key)) {
      const options = date ? {dateStyle:"short"} : {hour:"2-digit", minute:"2-digit", hourCycle:"h23"};
      formatters.set(key, new Intl.DateTimeFormat(date ? "sv-SE" : "pt-PT", {timeZone:zone, ...options}));
    }
    return formatters.get(key).format(at);
  }
  const clock = (at, zone) => dateFormat(at, zone, false);
  const dayKey = (at, zone) => dateFormat(at, zone, true);
  const hour = (at, zone) => Number(clock(at, zone).split(":")[0]);
  const average = (values, weights) => sum(values.map((value, i) => value * weights[i])) / sum(weights);
  const format = new Intl.NumberFormat("pt-PT", {maximumFractionDigits:0});

  function validate(data) {
    const sections = ["origins", "templates", "targets", "reports", "activity", "commands"];
    if (!data || sections.some(key => !Array.isArray(data[key]))) throw Error("Faltam listas. Usa a estrutura do exemplo.");
    const nonnegative = n => Number.isFinite(n) && n >= 0;
    const timestamp = value => Number.isFinite(time(value));
    const optionalTime = value => value == null || timestamp(value);
    const units = value => value && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value).every(([key, n]) => /^[a-z][a-z0-9_]*$/i.test(key) && Number.isSafeInteger(n) && n >= 0);
    const unique = (rows, key) => new Set(rows.map(row => row[key])).size === rows.length;
    if (!data.origins.every(o => coords.test(o.coord) && units(o.units) && units(o.reserve ?? {})) || !unique(data.origins, "coord")) throw Error("Origens inválidas ou repetidas.");
    if (!data.templates.every(t => typeof t.id === "string" && t.id && units(t.units) &&
      sum(Object.values(t.units)) > 0 && nonnegative(t.capacity) && t.capacity > 0 &&
      nonnegative(t.minutesPerField) && t.minutesPerField > 0) || !unique(data.templates, "id")) throw Error("Modelos inválidos ou repetidos.");
    if (!data.targets.every(t => coords.test(t.coord) && (t.wall == null || nonnegative(t.wall)) &&
      optionalTime(t.changedAt)) || !unique(data.targets, "coord")) throw Error("Alvos inválidos ou repetidos.");
    if (!data.reports.every(r => coords.test(r.target) && timestamp(r.at) && nonnegative(r.loot) &&
      (r.capacity == null || (nonnegative(r.capacity) && r.capacity >= r.loot)) &&
      (r.loss == null || nonnegative(r.loss)))) throw Error("Relatórios inválidos.");
    if (!data.activity.every(a => typeof a.player === "string" && a.player && timestamp(a.at) &&
      ["change", "raid"].includes(a.type))) throw Error("Observações de jogadores inválidas.");
    if (!data.commands.every(c => coords.test(c.origin) && coords.test(c.target) &&
      timestamp(c.arrives) && optionalTime(c.returns) && (c.returns == null || time(c.returns) >= time(c.arrives)) &&
      (c.units == null || units(c.units)))) throw Error("Comandos inválidos.");
    dayKey(Date.now(), data.zone ?? "Europe/Lisbon");
    return data;
  }

  function forecast(target, template, arrival, history, commands, zone, now) {
    const last = history.at(-1);
    const previousArrival = Math.max(time(last?.at) || 0, ...commands.map(c => time(c.arrives)).filter(at => at <= arrival));
    const since = previousArrival ? (arrival - previousArrival) / minute : Infinity;
    if (commands.some(c => time(c.arrives) > now && Math.abs(arrival - time(c.arrives)) < 20 * minute)) return null;

    const samples = history.map((report, i) => {
      const interval = i ? (time(report.at) - time(history[i - 1].at)) / minute : null;
      const gapWeight = interval && Number.isFinite(since) ? Math.exp(-Math.abs(Math.log((since + 15) / (interval + 15)))) : 0.65;
      const gapHours = Math.abs(hour(time(report.at), zone) - hour(arrival, zone));
      const hourWeight = Math.min(gapHours, 24 - gapHours) <= 1 ? 1.6 : 1;
      const weight = 0.5 ** ((now - time(report.at)) / (5 * day)) * gapWeight * hourWeight;
      const full = report.capacity > 0 && report.loot === report.capacity;
      const upper = full ? report.loot * 1.5 : report.loot;
      return {low:Math.min(report.loot, template.capacity), high:Math.min(upper, template.capacity), weight, loss:report.loss};
    });

    const weights = samples.map(s => s.weight);
    const weight = sum(weights);
    const confidence = weight / (weight + 1.5);
    const prior = template.capacity * (target.player ? 0.18 : 0.35);
    const lower = weight ? average(samples.map(s => s.low), weights) : prior;
    const upper = weight ? average(samples.map(s => s.high), weights) : prior;
    const depletion = Number.isFinite(since) ? Math.min(1, since / 45) : 1;
    const plannedBefore = commands.some(c => time(c.arrives) > now && time(c.arrives) <= arrival);
    const recovery = plannedBefore ? depletion : 0.55 + 0.45 * depletion;
    const expected = recovery * (confidence * (lower + upper) / 2 + (1 - confidence) * prior);
    const observedLosses = samples.filter(s => s.loss != null);
    const loss = observedLosses.length ? average(observedLosses.map(s => s.loss), observedLosses.map(s => s.weight)) : 0;
    const riskCost = loss + (target.wall ?? 0) * 18 + (target.player ? 90 : 0) + (target.wall == null ? 25 : 0);
    const matching = history.filter(r => {
      const hoursApart = Math.abs(hour(time(r.at), zone) - hour(arrival, zone));
      return Math.min(hoursApart, 24 - hoursApart) <= 1;
    });
    const reason = since < 45 ? "Regeneração recente" :
      matching.length >= 2 ? matching.length + " relatórios neste horário" :
      history.length ? history.length + " relatórios recentes" : "Exploração · poucos dados";
    return {expected, low:recovery * confidence * lower, high:recovery * (confidence * upper + (1 - confidence) * template.capacity), confidence, riskCost, reason};
  }

  function intel(data, now) {
    const zone = data.zone ?? "Europe/Lisbon";
    const players = new Set([...data.targets.map(t => t.player), ...data.activity.map(a => a.player)].filter(Boolean));
    const today = dayKey(now, zone);
    return [...players].map(player => {
      const rows = recent(data.activity.filter(a => a.player === player), now).sort((a,b) => time(b.at) - time(a.at));
      const daysByHour = Array.from({length:24}, () => new Set());
      for (const row of rows) daysByHour[hour(time(row.at), zone)].add(dayKey(time(row.at), zone));
      const peak = Math.max(...daysByHour.map(days => days.size));
      const peakHour = daysByHour.findIndex(days => days.size === peak);
      const raids = new Set(rows.filter(row => row.type === "raid" && dayKey(time(row.at), zone) === today)
        .map(row => row.id ?? time(row.at))).size;
      return {player, last:rows.length ? time(rows[0].at) : null, raids, peak, peakHour};
    });
  }

  function plan(data, now, options) {
    const zone = data.zone ?? "Europe/Lisbon";
    const cutoff = now + options.duration * minute;
    const candidates = [];
    const sorted = recent(data.reports, now).sort((a, b) => time(a.at) - time(b.at));
    const arrivals = new Map();
    const playerIntel = new Map(intel(data, now).map(info => [info.player, info]));
    const pressureByTarget = new Map(data.targets.map(target => [target.coord, regionalPressure(target.coord, options.nearby, options.ranking, options.date, options.self)]));
    const historyByTarget = new Map();
    for (const r of sorted) {
      if (!historyByTarget.has(r.target)) historyByTarget.set(r.target, []);
      historyByTarget.get(r.target).push(r);
    }
    for (const origin of data.origins) for (const target of data.targets) {
      if (target.blocked || data.origins.some(o => o.coord === target.coord) || (target.player && !options.players)) continue;
      const gap = distance(origin.coord, target.coord);
      const history = (historyByTarget.get(target.coord) ?? []).filter(r => time(r.at) >= (time(target.changedAt) || 0));
      const commands = data.commands.filter(c => c.target === target.coord);
      const returns = data.commands.filter(c => c.origin === origin.coord && c.units && time(c.returns) > now);
      const starts = [...new Set([now, now + 15 * minute, now + 30 * minute, now + 60 * minute, ...returns.map(c => time(c.returns))])].sort((a,b) => a - b);
      for (const template of data.templates) {
        for (const start of starts) {
          const travel = Math.ceil(gap * template.minutesPerField * 60) * 1000;
          const end = start + 2 * travel;
          if (end > cutoff) continue;
          const arrival = start + travel;
          const key = [target.coord, template.id, arrival].join("/");
          if (!arrivals.has(key)) arrivals.set(key, forecast(target, template, arrival, history, commands, zone, now));
          const prediction = arrivals.get(key);
          if (!prediction) continue;
          const owner = playerIntel.get(target.player);
          const ownerRank = options.ranking?.[target.playerId]?.days?.[options.date];
          const lastSignal = Math.max(owner?.last ?? 0, options.nearby?.players?.[target.playerId]?.changedAt ?? 0);
          const activeRecently = now - lastSignal < 2 * 60 * minute;
          const riskCost = prediction.riskCost + (activeRecently ? 45 : 0);
          const pressure = pressureByTarget.get(target.coord);
          const competition = pressure * (1 - 0.75 * prediction.confidence);
          const reason = [prediction.reason, activeRecently ? "dono com sinal recente" : ownerRank?.total > 0 ? "dono saqueou hoje" : "",
            competition >= 0.025 ? "concorrência estimada na zona" : ""].filter(Boolean).join(" · ");
          const expectedNet = prediction.expected * (1 - competition) - options.caution * riskCost;
          const troopHours = sum(Object.values(template.units)) * (end - start) / (60 * minute);
          const score = expectedNet * (2 / (1 + (end - now) / (60 * minute))) +
            (options.explore && prediction.confidence < 0.25 && !target.player ? Math.min(45, expectedNet * 0.25) : 0);
          if (score > 0) candidates.push({origin, target, template, start, arrival, end, returns, score, troopHours,
            ...prediction, expected:prediction.expected * (1 - competition), low:prediction.low * (1 - competition), riskCost, reason});
        }
      }
    }

    function fits(candidate, selected) {
      const {origin, template, start, end, returns} = candidate;
      const parallel = selected.filter(s => s.origin.coord === origin.coord && start < s.end && s.start < end);
      const events = [start, ...parallel.map(s => s.start).filter(at => at > start)];
      return events.every(at => Object.entries(template.units).every(([unit, count]) => {
        const returned = sum(returns.filter(c => time(c.returns) <= at).map(c => c.units[unit] ?? 0));
        const used = sum(parallel.filter(s => s.start <= at && at < s.end).map(s => s.template.units[unit] ?? 0));
        return count === 0 || count + used <= (origin.units[unit] ?? 0) + returned - (origin.reserve?.[unit] ?? 0);
      }));
    }

    // Várias ordens de preenchimento comparam volume, rendimento e ocupação das tropas.
    const orders = [
      c => c.score,
      c => c.score / Math.max(0.2, c.troopHours) ** 0.65,
      c => c.score / Math.max(1, sum(Object.values(c.template.units))) ** 0.5,
      c => c.score / (1 + (c.start - now) / (30 * minute))
    ];
    const plans = orders.map(priority => {
      const ranked = candidates.map(c => [priority(c), c]).sort((a,b) => b[0] - a[0]);
      const selected = [];
      const targets = new Set();
      for (const [, candidate] of ranked) {
        if (targets.has(candidate.target.coord) || !fits(candidate, selected)) continue;
        targets.add(candidate.target.coord);
        selected.push(candidate);
        if (selected.length >= options.limit) break;
      }
      return {selected, score:sum(selected.map(c => c.score))};
    });
    return plans.sort((a,b) => b.score - a.score)[0].selected.sort((a,b) => a.start - b.start || b.score - a.score);
  }

  function mergeRanking(history, entries, date, capturedAt) {
    const updated = {...history};
    for (const entry of entries) {
      const previous = updated[entry.id] ?? {days:{}};
      const days = {...previous.days};
      const sameDay = days[date];
      if (!sameDay || sameDay.at <= capturedAt) {
        days[date] = {total:entry.total, at:capturedAt,
          increasedAt:sameDay && entry.total > sameDay.total ? capturedAt : sameDay?.increasedAt};
      }
      updated[entry.id] = {...previous, name:entry.name, days};
    }
    return updated;
  }

  function mapRows(text) {
    return text.split(/\r?\n/).filter(line => /^\d+,/.test(line)).map(line => line.split(","));
  }

  function decodeMapName(name) {
    try { return decodeURIComponent(name.replace(/\+/g, " ")); }
    catch { return name; }
  }

  function mapNeighborhood(villageText, playerText, bases, radius, self, previous, at) {
    const anchors = [...new Set(bases)];
    const villages = [];
    const nearest = new Map();
    let validVillages = 0;
    for (const [id,mapName,x,y,owner] of mapRows(villageText)) {
      if (!/^\d{1,3}$/.test(x) || !/^\d{1,3}$/.test(y) || !/^\d+$/.test(owner)) continue;
      validVillages++;
      const coord = Number(x) + "|" + Number(y);
      const gap = Math.min(...anchors.map(base => distance(base, coord)));
      if (gap > radius + 8) continue;
      const old = previous?.villages?.[coord];
      villages.push([coord, {id, owner, name:decodeMapName(mapName), distance:gap, changedAt:old?.owner === owner ? old.changedAt : old ? at : 0}]);
      if (owner !== "0" && owner !== self && gap <= radius) {
        nearest.set(owner, Math.min(gap, nearest.get(owner) ?? Infinity));
      }
    }
    const players = {};
    let validPlayers = 0;
    for (const [id,name,,count,points] of mapRows(playerText)) {
      if (!name || !/^\d+$/.test(count) || !/^\d+$/.test(points)) continue;
      validPlayers++;
      if (!nearest.has(id)) continue;
      const prior = previous?.players?.[id];
      const changed = prior && (prior.points !== Number(points) || prior.count !== Number(count));
      players[id] = {name:decodeMapName(name), count:Number(count), points:Number(points),
        distance:nearest.get(id), changedAt:changed ? at : prior?.changedAt ?? 0};
    }
    if (!validVillages || !validPlayers) throw Error("O mundo não forneceu dados de mapa reconhecíveis.");
    return {bases:anchors, radius, at, players, villages:Object.fromEntries(villages)};
  }

  function regionalPressure(coord, nearby, history, date, self) {
    if (!nearby || !history || !date) return 0;
    const closest = new Map();
    for (const [village, data] of Object.entries(nearby.villages)) {
      if (data.owner === "0" || data.owner === self || !history[data.owner]) continue;
      const gap = distance(coord, village);
      if (gap <= 8) closest.set(data.owner, Math.min(gap, closest.get(data.owner) ?? Infinity));
    }
    let pressure = 0;
    for (const [id, gap] of closest) {
      const days = history[id].days;
      const cutoff = new Date(Date.parse(date) - 14 * day).toISOString().slice(0,10);
      const previous = Object.keys(days).filter(key => key < date && key >= cutoff).sort().slice(-7);
      const baseline = previous.length ? sum(previous.map(key => days[key].total)) / previous.length : 0;
      const amount = Math.max(days[date]?.total ?? 0, baseline * 0.4);
      pressure += Math.min(0.07, Math.log1p(amount / 1000) * 0.025) * (1 - gap / 9);
    }
    return Math.min(pressure, 0.15);
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {validate, forecast, intel, plan, mergeRanking, mapNeighborhood, regionalPressure};
    return;
  }

  const game = /(^|\.)(tribos|tribalwars)\.com\.pt$/.test(location.hostname);
  const demo = document.body.hasAttribute("data-saque-demo");
  if (!game && !demo) return;

  const host = document.createElement("div");
  host.id = "plano-de-saque";
  const existing = document.getElementById(host.id);
  if (existing) {
    existing.shadowRoot.querySelector("dialog").showModal();
    return;
  }

  const key = "plano-de-saque:v1:" + location.hostname + ":" + (window.game_data?.player?.id ?? "local");
  const rankingKey = "plano-de-saque:ranking:v1:" + location.hostname;
  const mapKey = key + ":map";
  const self = String(window.game_data?.player?.id ?? "");
  const blank = () => ({zone:"Europe/Lisbon", origins:[], templates:[], targets:[], reports:[], activity:[], commands:[]});
  function sample(now) {
    const data = blank();
    data.origins = [
      {coord:"510|490", name:"Base Norte", units:{light:24}, reserve:{light:5}},
      {coord:"514|492", name:"Base Sul", units:{light:16}, reserve:{light:3}}
    ];
    data.templates = [
      {id:"A", units:{light:3}, capacity:240, minutesPerField:10},
      {id:"B", units:{light:6}, capacity:480, minutesPerField:10}
    ];
    data.targets = ["Vale Seco","Quinta Velha","Monte Baixo","Fonte Clara","Campo Longo","Olival","Pedra Alta","Ribeira","Courelas","Pinhal"].map((name,i) => ({
      name, coord:(511 + i % 5) + "|" + (488 + Math.floor(i / 5) * 3), wall:i === 9 ? 2 : 0,
      player:i === 9 ? "Lusitano87" : undefined
    }));
    for (let i = 0; i < data.targets.length; i++) {
      for (let j = 0; j < 5; j++) data.reports.push({
        target:data.targets[i].coord, at:new Date(now - j * day - (55 + i*7) * minute).toISOString(),
        loot:Math.min(480, 160 + (i*97 + j*39) % 370), capacity:480, loss:i === 9 ? 120 : 0
      });
    }
    data.activity = [
      {player:"Lusitano87", at:new Date(now - 7 * minute).toISOString(), type:"raid", id:"demo-1"},
      {player:"Lusitano87", at:new Date(now - day).toISOString(), type:"change"},
      {player:"Lusitano87", at:new Date(now - 2 * day).toISOString(), type:"change"}
    ];
    return data;
  }

  let state = demo ? sample(Date.now()) : blank();
  let storageIssue = "";
  try {
    const saved = localStorage.getItem(key);
    if (saved) state = validate(JSON.parse(saved));
  } catch {
    storageIssue = "O histórico local não pôde ser lido.";
  }

  const root = host.attachShadow({mode:"open"});
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial}
    *{box-sizing:border-box}
    dialog{width:min(1480px,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - 32px);padding:0;
      border:1px solid #b9aa86;border-radius:12px;color:#272a21;background:#f7f2e6;
      box-shadow:0 22px 100px #101e17aa;font:15px/1.45 system-ui,sans-serif}
    dialog::backdrop{background:#102217a6}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:13px 18px;background:#542b1c;color:#fff1cf;border-bottom:3px solid #ad7845}
    h1{font:700 clamp(23px,4vw,34px)/1 Georgia,serif;margin:0}
    .actions,.controls,.formrow{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
    .page{padding:18px;display:grid;gap:14px}
    .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .stat,.controls,details,.table{border:1px solid #c6b38a;border-radius:8px;background:#fffcf372}
    .stat{padding:12px 20px;color:#1e3d29}
    .stat span{display:block;font:700 19px Georgia,serif;color:#323024}
    .stat strong{font:700 clamp(26px,4vw,40px) Georgia,serif}
    .stat small{margin-left:6px}
    .controls{padding:12px 16px}
    .controls label{display:flex;align-items:center;gap:7px}
    .primary{margin-left:auto;color:#fff6de;background:#205135;border-color:#205135}
    button,select,input,textarea{font:inherit;color:inherit}
    button,select,input:not([type=checkbox]):not([type=file]){padding:7px 10px;border:1px solid #b5a179;border-radius:5px;background:#fffcf4}
    button{font-weight:650;cursor:pointer}
    button.primary,.launch{background:#205135;color:#fff6de}
    .top button{background:transparent;color:#fff6de;border-color:#d0ad54}
    button:hover{filter:brightness(.93)}
    button:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #ae7e17;outline-offset:2px}
    .table{overflow:auto}
    table{width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}
    th,td{padding:8px 12px;border-bottom:1px solid #d8ccb1;vertical-align:top}
    th{background:#284d34;color:#fff7df;white-space:nowrap}
    th button[data-sort]{padding:0;border:0;color:inherit;background:none}
    tbody tr:nth-child(even){background:#ede4d265}
    tbody tr:hover{background:#eadbb8}
    td:first-child strong,td.loot strong{color:#173923}
    td small{display:block;color:#5c5c47;white-space:nowrap}
    .empty{padding:24px;text-align:center;color:#61543b}
    details{overflow:hidden}
    summary{background:#294a34;color:#fff7df;padding:8px 14px;cursor:pointer;font:700 21px Georgia,serif}
    .inside{padding:12px 14px;display:grid;gap:10px}
    .inside p,.status{margin:0}
    textarea{width:100%;min-height:170px;background:#fffdf7;border:1px solid #b5a179;border-radius:5px;padding:10px;font:13px/1.55 Consolas,monospace}
    .status{color:#5c4925}
    .launcher{position:fixed;right:16px;bottom:16px;z-index:10000;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:calc(100vw - 32px)}
    button.launch{background:#205135;color:#fff6de;box-shadow:0 4px 16px #0004}
    #rank-rows details{background:transparent;border:0}
    #rank-rows summary{background:transparent;color:#173923;font:inherit;font-weight:650;padding:0}
    #rank-rows details div{padding:3px 0 0 16px;color:#5c5c47}
    dialog{width:min(1050px,calc(100vw - 24px));background:#f4e4be;color:#432a19;border:2px solid #805434;border-radius:5px;font:14px/1.4 system-ui,sans-serif}
    dialog::backdrop{background:#29150c99}
    [hidden]{display:none!important}
    .scanner{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:10px;background:#e6c891;border:1px solid #b58b56}
    .scanner button{background:#7a3426;color:#fff1cf;border-color:#623124}
    .scanner button:disabled{opacity:.65;cursor:wait}
    a{color:#693322;text-underline-offset:2px}
    .tabs{display:flex;gap:4px;border-bottom:1px solid #a67948}
    .tabs button{background:#efe0bd;border-radius:4px 4px 0 0}
    .tabs button[aria-pressed=true]{background:#694129;color:#fff1d2}
    th,summary{background:#775035;color:#fff1d2}
    .table{border-color:#b58b56;border-radius:4px}
    tbody tr:nth-child(even){background:#ead5a9}
    tbody tr:hover{background:#e8c589}
    .map-key{font-size:12px;color:#55371d}
    #native-list td:last-child{white-space:nowrap}
    #native-list button{margin-right:5px;padding:3px 9px}
    button.launch{background:#694129}
    #map-layer{position:fixed;inset:0;z-index:110;pointer-events:none}
    .village-mark{position:absolute;transform:translate(-50%,-95%);padding:0 3px;
      border:1px solid #805434;border-radius:3px;background:#fff2ce;color:#4c2815;
      white-space:nowrap;font:700 10px/14px system-ui,sans-serif;box-shadow:0 1px 2px #39231055}
    .village-mark.recent{border-color:#467035;color:#294f23}
    @media(max-width:660px){dialog{width:calc(100vw - 12px);max-height:calc(100dvh - 12px)}.top,.page{padding:12px}.stats{gap:6px}.stat{padding:8px}.stat span{font-size:14px}.stat strong{font-size:24px}.stat small{display:block;margin:0}.controls{display:grid}.primary{margin:0}.top button{font-size:12px}.formrow{align-items:stretch}}
  `;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "title");
  dialog.innerHTML = `
    <header class="top"><h1 id="title">Plano de saque</h1><div class="actions"><button id="close">Fechar</button></div></header>
    <main class="page">
      <div class="scanner"><button id="scan">Scan completo</button><label>Raio <select id="radius"><option>5</option><option selected>10</option><option>15</option><option>20</option></select> campos</label><span id="scan-status" role="status"></span></div>
      <nav class="tabs" aria-label="Vistas do painel"><button data-view="farm">Bárbaras</button><button data-view="neighbors">Vizinhos</button><button data-view="advanced">Avançado</button></nav>
      <section data-pane="farm">
        <p class="status" id="farm-status"></p>
        <p><a id="open-farm">Abrir Assistente de Saque</a></p>
        <div class="table"><table><thead><tr><th>Aldeia</th><th>Distância</th><th>Saque no Assistente</th></tr></thead><tbody id="native-list"></tbody></table></div>
      </section>
      <section data-pane="advanced" hidden>
      <p class="status" id="status" role="status"></p>
      <section class="stats" aria-label="Resumo da sessão">
        <div class="stat"><span>Saque previsto</span><strong id="total">—</strong><small>recursos</small></div>
        <div class="stat"><span>Saque por hora</span><strong id="rate">—</strong><small>recursos/h</small></div>
        <div class="stat"><span>Envios</span><strong id="count">—</strong><small>no plano</small></div>
      </section>
      <form class="controls" id="controls">
        <label>Duração <select id="duration"><option value="60">1 hora</option><option value="120">2 horas</option><option value="240" selected>4 horas</option><option value="360">6 horas</option><option value="720">12 horas</option></select></label>
        <label>Risco <select id="risk"><option value="2">Conservador</option><option value="1" selected>Equilibrado</option><option value="0.5">Agressivo</option></select></label>
        <label><input type="checkbox" id="players"> Incluir aldeias de jogadores</label>
        <label><input type="checkbox" id="explore" checked> Explorar</label>
        <button class="primary">Gerar plano</button>
      </form>
      <div class="table"><table>
        <thead><tr><th><button data-sort="target">Alvo ↕</button></th><th>Origem</th><th>Modelo</th><th><button data-sort="start">Enviar ↕</button></th><th>Chegada / Regresso</th><th><button data-sort="loot">Saque previsto ↕</button></th><th>Motivo</th></tr></thead>
        <tbody id="plan"></tbody>
      </table></div>
      <details id="intel"><summary>Informação de jogadores</summary><div class="inside" id="player-list"></div></details>
      <details id="inputs"><summary>Importação de dados</summary><div class="inside">
        <p>Importa um ficheiro JSON ou edita os dados no campo abaixo. Guarda para recalcular.</p>
        <div class="formrow"><button id="capture">Ler alvos visíveis</button><button id="example">Ver exemplo</button><button id="export">Exportar dados</button><label>Importar JSON <input id="file" type="file" accept=".json,application/json"></label></div>
        <textarea id="json" aria-label="Dados do plano em JSON" spellcheck="false"></textarea>
        <div class="formrow"><button id="save" class="primary">Guardar dados</button></div>
      </div></details>
      </section>
      <section data-pane="neighbors" hidden>
        <div class="formrow"><button id="export-ranking">Exportar histórico</button><label><input id="tracked-only" type="checkbox" checked> Só vizinhos e acompanhados</label><label id="map-option"><input id="show-map" type="checkbox" checked> Marcadores no mapa</label></div>
        <p id="map-status" role="status"></p>
        <p id="rank-status" role="status"></p>
        <p class="map-key">● Sinal recente · ◇ Saque registado hoje · ? Sem sinal recente</p>
        <div class="table"><table><thead><tr><th>Jogador</th><th>Distância</th><th>Saque hoje</th><th>Dia anterior</th><th>Atividade</th><th>Acompanhar</th></tr></thead><tbody id="rank-rows"></tbody></table></div>
      </section>
    </main>`;

  const $ = id => root.getElementById(id);
  const quantity = (count, singular, plural) => format.format(count) + " " + (count === 1 ? singular : plural);
  const launch = document.createElement("button");
  launch.className = "launch";
  launch.textContent = "Plano de saque";
  const toolbar = document.createElement("div");
  toolbar.className = "launcher";
  toolbar.append(launch);
  const markerLayer = document.createElement("div");
  markerLayer.id = "map-layer";
  markerLayer.setAttribute("aria-hidden","true");
  root.append(style, toolbar, markerLayer, dialog);
  document.body.append(host);
  const message = content => { $("status").textContent = content; };
  function writeEditor(data) { $("json").value = JSON.stringify(data, null, 2); }
  function commit(data) {
    validate(data);
    state = data;
    storageIssue = "";
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch {
      storageIssue = "O navegador não guardou os dados. Exporta-os antes de fechar a página.";
    }
    writeEditor(data);
    calculate();
  }

  let rows = [];
  let sort = "start";
  let reverse = false;
  let referenceTime;
  function renderPlan() {
    const table = $("plan");
    table.replaceChildren();
    const zone = state.zone ?? "Europe/Lisbon";
    const compare = {start:(a,b) => a.start - b.start || b.score - a.score,
      loot:(a,b) => b.expected - a.expected, target:(a,b) => a.target.coord.localeCompare(b.target.coord)};
    const ranked = [...rows].sort((a,b) => (reverse ? -1 : 1) * compare[sort](a,b));
    for (const header of root.querySelectorAll("[data-sort]")) {
      if (header.dataset.sort === sort) header.parentElement.setAttribute("aria-sort", (sort === "loot") !== reverse ? "descending" : "ascending");
      else header.parentElement.removeAttribute("aria-sort");
    }
    if (!ranked.length) {
      const cell = table.insertRow().insertCell();
      cell.colSpan = 7;
      cell.className = "empty";
      cell.textContent = state.origins.length && state.targets.length && state.templates.length
        ? "O plano não encontrou envios viáveis com estes dados e filtros."
        : "Adiciona origens, modelos e alvos em Dados para calcular o plano.";
      return;
    }
    for (const job of ranked) {
      const row = table.insertRow();
      const values = [
        [job.target.name ?? job.target.coord, job.target.name ? job.target.coord : job.target.player],
        [job.origin.name ?? job.origin.coord, job.origin.name ? job.origin.coord : ""],
        [job.template.id, Object.entries(job.template.units).filter(([,n]) => n).map(([unit,n]) => n + " × " + unit).join(" · ")],
        [job.start === referenceTime ? "Agora" : clock(job.start, zone)],
        [clock(job.arrival, zone) + " / " + clock(job.end, zone)],
        [format.format(job.expected), format.format(job.low) + "–" + format.format(job.high) + " plausíveis"],
        [job.reason, "Confiança " + (job.confidence >= .7 ? "alta" : job.confidence >= .35 ? "média" : "baixa") + " · penalização " + format.format(job.riskCost)]
      ];
      values.forEach(([main, detail], i) => {
        const cell = row.insertCell();
        if (i === 5) cell.className = "loot";
        const label = document.createElement(i === 0 || i === 5 ? "strong" : "span");
        label.textContent = main;
        cell.append(label);
        if (detail) {
          const small = document.createElement("small");
          small.textContent = detail;
          cell.append(small);
        }
      });
    }
  }

  function calculate() {
    referenceTime = Date.now();
    const duration = Number($("duration").value);
    const nearby = readNearby();
    const ranking = storedRanking();
    const targets = new Map(state.targets.map(target => [target.coord,target]));
    for (const [coord, village] of Object.entries(nearby?.villages ?? {})) {
      if (village.distance <= nearby.radius && !targets.has(coord)) targets.set(coord,{coord,name:village.name});
    }
    const data = {...state, targets:[...targets.values()].map(target => {
      const entry = nearby?.villages?.[target.coord];
      if (!entry) return target;
      const owner = entry.owner !== "0" ? entry.owner : null;
      return {...target, playerId:owner, player:owner ? nearby.players[owner]?.name ?? target.player ?? "Jogador " + owner : undefined,
        blocked:target.blocked || (!!self && owner === self), changedAt:Math.max(time(target.changedAt) || 0, entry.changedAt || 0)};
    })};
    rows = plan(data, referenceTime, {duration, caution:Number($("risk").value), players:$("players").checked,
      explore:$("explore").checked, limit:60, nearby, ranking, date:rankingDate(), self});
    const expected = sum(rows.map(row => row.expected));
    $("total").textContent = format.format(expected);
    $("rate").textContent = format.format(expected / (duration / 60));
    $("count").textContent = String(rows.length);
    renderPlan();
    const zone = state.zone ?? "Europe/Lisbon";
    const players = intel(state, referenceTime);
    $("player-list").replaceChildren();
    for (const info of players) {
      const p = document.createElement("p");
      p.textContent = [
        info.player,
        info.last ? "Último sinal " + dayKey(info.last, zone) + " às " + clock(info.last, zone) : "Atividade desconhecida",
        info.raids ? "Saques hoje: " + info.raids + (info.raids === 1 ? " confirmado" : " confirmados") : "Saques hoje: desconhecido",
        info.peak > 1 ? "Janela observada " + String(info.peakHour).padStart(2,"0") + "h em " + info.peak + " dias" : "Histórico horário insuficiente"
      ].join(" · ");
      $("player-list").append(p);
    }
    if (!players.length) $("player-list").textContent = "Adiciona observações em Dados para acompanhar jogadores.";
    message(storageIssue || (demo ? "Demonstração local · dados fictícios" : "Sugestões para execução manual") +
      " · " + state.targets.length + " alvos · " + state.reports.length + " relatórios");
  }

  function captureTargets() {
    const records = new Map(state.targets.map(target => [target.coord, target]));
    const nearby = readNearby();
    let seen = 0;
    const containers = document.querySelectorAll("#plunder_list, #plunder_list_table");
    const links = new Set([...containers].flatMap(container => [...container.querySelectorAll('a[href*="screen=info_village"]')]));
    for (const link of links) {
      if (!link.getClientRects().length) continue;
      const coord = link.textContent.match(/\b\d{1,3}\|\d{1,3}\b/)?.[0];
      if (!coord || records.has(coord)) continue;
      const name = link.textContent.split(coord)[0].replace(/\s*\($/, "").trim();
      // A presença no Assistente não identifica por si só o proprietário.
      const owner = nearby?.villages?.[coord]?.owner;
      records.set(coord, {coord, name:name || coord, blocked:owner !== "0"});
      seen++;
    }
    if (!seen) {
      message("Nenhum alvo novo encontrado. Abre a lista do Assistente ou adiciona coordenadas nos dados.");
      return;
    }
    writeEditor({...state, targets:[...records.values()]});
    message(seen + " alvos novos no editor. Confirma os alvos bloqueados e guarda os dados.");
  }

  const screen = new URLSearchParams(location.search).get("screen");
  const dispatched = new WeakSet();
  function gameUrl(nextScreen, parameters = {}) {
    const url = new URL("/game.php", location.href);
    const current = new URLSearchParams(location.search);
    for (const key of ["village","t"]) if (current.has(key)) url.searchParams.set(key, current.get(key));
    for (const [key, value] of Object.entries({screen:nextScreen, ...parameters})) url.searchParams.set(key, value);
    return url;
  }

  function renderNative() {
    const list = $("native-list");
    list.replaceChildren();
    const farm = document.querySelector("#plunder_list, #plunder_list_table");
    const map = readNearby();
    const targets = new Map(Object.entries(map?.villages ?? {}).filter(([,v]) => v.owner === "0" && v.distance <= map.radius));
    const nativeRows = new Map();
    for (const row of farm?.querySelectorAll("tr") ?? []) {
      if (!row.getClientRects().length) continue;
      const coord = row.textContent.match(/\b\d{1,3}\|\d{1,3}\b/)?.[0];
      if (coord && (!map || map.villages[coord]?.owner === "0")) nativeRows.set(coord, row);
    }
    for (const coord of nativeRows.keys()) if (!targets.has(coord)) targets.set(coord, {name:"Alvo do Assistente"});
    const ordered = [...targets].sort(([a,av],[b,bv]) => Number(nativeRows.has(b)) - Number(nativeRows.has(a)) ||
      (av.distance ?? Infinity) - (bv.distance ?? Infinity));
    for (const [coord, target] of ordered) {
      const row = nativeRows.get(coord);
      const buttons = [];
      for (const model of ["a","b"]) {
        const native = row?.querySelector(".farm_icon_" + model);
        if (!native || !native.getClientRects().length || !native.closest("a,button")) continue;
        const control = native.closest("a,button");
        const button = document.createElement("button");
        button.textContent = "Enviar " + model.toUpperCase();
        const unavailable = () => !control.isConnected || !control.getClientRects().length ||
          dispatched.has(control) || control.matches(":disabled,.disabled,[aria-disabled=true]") ||
          !!native.closest(".farm_icon_disabled,.disabled,[aria-disabled=true]");
        button.disabled = unavailable();
        button.onclick = () => {
          if (unavailable()) return;
          dispatched.add(control);
          button.disabled = true;
          dialog.close();
          control.click();
        };
        buttons.push(button);
      }
      const line = list.insertRow();
      const label = line.insertCell();
      const title = document.createElement(target.id && game ? "a" : "strong");
      title.textContent = (target.name || "Aldeia bárbara") + " (" + coord + ")";
      if (target.id && game) title.href = String(gameUrl("info_village",{id:target.id}));
      label.append(title);
      line.insertCell().textContent = Number.isFinite(target.distance) ? target.distance.toFixed(1).replace(".",",") : "—";
      const actions = line.insertCell();
      if (buttons.length) actions.append(...buttons);
      else actions.textContent = "Sem botão disponível";
    }
    $("open-farm").hidden = !!farm || !game;
    $("open-farm").href = String(gameUrl("am_farm"));
    $("farm-status").textContent = ordered.length
      ? quantity(ordered.length,"aldeia na lista","aldeias na lista") + " · " + quantity(nativeRows.size,"visível no Assistente","visíveis no Assistente")
      : "Clica em «Scan completo» para procurar aldeias bárbaras.";
  }

  const simplify = value => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const dailyTitle = /recursos\s+(?:saqueados|pilhados)\s*\(?hoje/;
  function rankingEntries(page = document, source = location.href, today = rankingDate()) {
    const sourceUrl = new URL(source, location.href);
    const knownDaily = sourceUrl.searchParams.get("mode") === "in_a_day" && sourceUrl.searchParams.get("type") === "loot_res";
    if (!demo && sourceUrl.searchParams.get("screen") !== "ranking") return [];
    const selectedDaily = [...page.querySelectorAll("h1,h2,h3,.selected,.active,option:checked")]
      .some(node => dailyTitle.test(simplify(node.textContent.trim())) && node.textContent.trim().length < 100);
    const entries = new Map();
    const tables = knownDaily ? page.querySelectorAll("#in_a_day_ranking_table") : page.querySelectorAll("table");
    for (const table of tables) {
      const isDailyColumn = cell => {
        const label = simplify(cell.textContent);
        return cell.tagName === "TH" && (dailyTitle.test(label) || (selectedDaily && /^\s*(recursos|saque|pilhagem)/.test(label)));
      };
      const heading = [...table.rows].find(row => [...row.cells].some(isDailyColumn));
      if (!knownDaily && (!heading || [...heading.cells].some(cell => cell.colSpan !== 1))) continue;
      const index = heading ? [...heading.cells].findIndex(isDailyColumn) : 3;
      const header = [...table.rows].find(row => [...row.cells].some(cell => cell.tagName === "TH"));
      const dateIndex = header ? [...header.cells].findIndex(cell => /^(data|date|dia)$/.test(simplify(cell.textContent.trim()))) : -1;
      const yesterday = new Date(Date.parse(today) - day).toISOString().slice(0,10);
      for (const row of table.rows) {
        const link = row.querySelector('a[href*="screen=info_player"]');
        const cell = row.cells[index];
        if (!link || !cell || (page === document && !row.getClientRects().length) || row.closest("table") !== table) continue;
        const url = new URL(link.getAttribute("href"), sourceUrl);
        const id = url.searchParams.get("id") ?? url.searchParams.get("player_id");
        const name = link.textContent.trim();
        const raw = cell.textContent.trim();
        if (url.origin !== location.origin || !/^\d+$/.test(id ?? "") || !name || !/^\d[\d.,\s]*$/.test(raw)) continue;
        const total = Number(raw.replace(/\D/g, ""));
        const label = simplify(row.cells[dateIndex]?.textContent.trim() ?? "");
        const absolute = label.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
        const date = dateIndex < 0 || /^(hoje|today)$/.test(label) ? today :
          /^(ontem|yesterday)$/.test(label) ? yesterday :
          absolute ? [absolute[3],absolute[2].padStart(2,"0"),absolute[1].padStart(2,"0")].join("-") : null;
        if (date && date <= today && Number.isFinite(Date.parse(date)) && Number.isSafeInteger(total)) {
          const key = id + "/" + date;
          if (!entries.has(key) || entries.get(key).total < total) entries.set(key,{id,name,total,date});
        }
      }
    }
    return [...entries.values()];
  }

  function rankingDate() {
    const date = document.getElementById("serverDate")?.textContent.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
    return date ? [date[3], date[2].padStart(2,"0"), date[1].padStart(2,"0")].join("-") :
      dayKey(Date.now(), state.zone ?? "Europe/Lisbon");
  }

  const readRanking = () => JSON.parse(localStorage.getItem(rankingKey) ?? "{}");
  const saveRanking = data => localStorage.setItem(rankingKey, JSON.stringify(data));
  const rankStatus = message => { $("rank-status").textContent = message; };
  function storedRanking() {
    try { return readRanking(); }
    catch { return {}; }
  }

  function readNearby() {
    try { return JSON.parse(localStorage.getItem(mapKey) ?? "null"); }
    catch { return null; }
  }

  function mapBases() {
    const headerCoord = document.getElementById("header_info")?.textContent.match(/\b\d{1,3}\|\d{1,3}\b/)?.[0];
    return [...new Set([window.game_data?.village?.coord ?? headerCoord, ...state.origins.map(origin => origin.coord)].filter(value => typeof value === "string" && coords.test(value)))];
  }

  async function refreshNearby() {
    const bases = mapBases();
    if (!bases.length) throw Error("Seleciona uma aldeia de origem.");
    const radius = Number($("radius").value);
    async function worldFile(name) {
      const response = await fetch("/map/" + name + ".txt", {credentials:"same-origin", signal:AbortSignal.timeout(12000)});
      if (!response.ok) throw Error("O mapa respondeu com HTTP " + response.status + ".");
      return response.text();
    }
    const [villages, players] = await Promise.all([worldFile("village"), worldFile("player")]);
    const snapshot = mapNeighborhood(villages, players, bases, radius, self, readNearby(), Date.now());
    localStorage.setItem(mapKey, JSON.stringify({...snapshot, worldDate:rankingDate()}));
    return snapshot;
  }

  function activitySignal(reading, changedAt, now = Date.now()) {
    const latest = Math.max(reading?.increasedAt ?? 0, changedAt ?? 0);
    if (latest > 0 && latest <= now && now - latest < 3 * 60 * minute) return {symbol:"●", detail:"Sinal observado nas últimas 3 horas"};
    if (reading?.total > 0) return {symbol:"◇", detail:"Saque registado hoje"};
    return {symbol:"?", detail:"Sem sinal recente"};
  }

  let markerFrame = 0;
  const compact = new Intl.NumberFormat("pt-PT", {notation:"compact",maximumFractionDigits:1});
  function queueMapMarkers() {
    if (screen !== "map" || markerFrame) return;
    markerFrame = requestAnimationFrame(() => {
      markerFrame = 0;
      const map = document.querySelector("#map_container, #map");
      if (!map || !$("show-map").checked) {
        markerLayer.replaceChildren();
        return;
      }
      const snapshot = readNearby();
      const history = storedRanking();
      const date = rankingDate();
      const byVillageId = new Map(Object.values(snapshot?.villages ?? {}).map(village => [village.id, village.owner]));
      for (const village of Object.values(window.TWMap?.villages ?? {})) {
        if (village?.id == null) continue;
        const owner = String(village.owner ?? village.player_id ?? "");
        if (/^\d+$/.test(owner)) byVillageId.set(String(village.id),owner);
      }
      const bounds = map.getBoundingClientRect();
      const marks = document.createDocumentFragment();
      for (const icon of map.querySelectorAll('[id^="map_village_"]')) {
        const owner = byVillageId.get(icon.id.slice("map_village_".length));
        if (!owner || owner === "0" || owner === self) continue;
        const rect = icon.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top;
        if (!rect.width || x < Math.max(0,bounds.left) || x > Math.min(innerWidth,bounds.right) ||
            y < Math.max(0,bounds.top) || y > Math.min(innerHeight,bounds.bottom)) continue;
        const reading = history[owner]?.days?.[date];
        const signal = activitySignal(reading,snapshot?.players?.[owner]?.changedAt);
        const marker = document.createElement("span");
        marker.className = "village-mark" + (signal.symbol === "●" ? " recent" : "");
        marker.style.left = x + "px";
        marker.style.top = y + "px";
        marker.textContent = signal.symbol + " " + (reading ? compact.format(reading.total) : "—");
        marks.append(marker);
      }
      markerLayer.replaceChildren(marks);
    });
  }

  function startMapMarkers() {
    $("map-option").hidden = screen !== "map";
    if (screen !== "map") return;
    $("show-map").checked = localStorage.getItem(mapKey + ":markers") !== "off";
    $("show-map").onchange = () => {
      localStorage.setItem(mapKey + ":markers", $("show-map").checked ? "on" : "off");
      queueMapMarkers();
    };
    const map = document.querySelector("#map_container, #map");
    if (map) {
      new MutationObserver(queueMapMarkers).observe(map,{subtree:true,childList:true,attributes:true,attributeFilter:["style","class"]});
      map.addEventListener("pointermove", event => { if (event.buttons) queueMapMarkers(); }, {passive:true});
    }
    window.addEventListener("resize",queueMapMarkers);
    window.addEventListener("scroll",queueMapMarkers,{passive:true,capture:true});
    window.addEventListener("storage",queueMapMarkers);
    queueMapMarkers();
  }

  function renderRanking() {
    const table = $("rank-rows");
    table.replaceChildren();
    let history;
    try { history = readRanking(); }
    catch { rankStatus("Não foi possível ler o histórico local."); return; }
    const today = rankingDate();
    const nearby = readNearby();
    const neighbors = nearby?.players ?? {};
    const owners = new Set(state.targets.map(target => target.player).filter(Boolean));
    $("map-status").textContent = nearby
      ? quantity(Object.keys(neighbors).length,"vizinho","vizinhos") + " num raio de " + nearby.radius + " campos · mapa consultado em " + dayKey(nearby.at, state.zone ?? "Europe/Lisbon")
      : "Atualiza o mapa para identificar os vizinhos por distância.";
    const allIds = new Set([...Object.keys(history), ...Object.keys(neighbors)]);
    allIds.delete(self);
    const players = [...allIds].map(id => [id, history[id] ?? {name:neighbors[id].name, days:{}}])
      .filter(([id,player]) => !$("tracked-only").checked || (player.tracked ?? (!!neighbors[id] || owners.has(player.name))))
      .sort(([left,a],[right,b]) => (b.days[today]?.total ?? -1) - (a.days[today]?.total ?? -1) ||
        (neighbors[left]?.distance ?? Infinity) - (neighbors[right]?.distance ?? Infinity));
    if (!players.length) {
      const empty = table.insertRow().insertCell();
      empty.colSpan = 6;
      empty.textContent = "Sem jogadores acompanhados. Atualiza o mapa ou desmarca «Só acompanhados».";
    }
    for (const [id, player] of players) {
      const neighbor = neighbors[id];
      const previous = Object.keys(player.days).filter(date => date < today).sort().at(-1);
      const row = table.insertRow();
      const name = row.insertCell();
      const timeline = document.createElement("details");
      const title = document.createElement("summary");
      title.textContent = player.name;
      timeline.append(title);
      for (const date of Object.keys(player.days).sort().reverse()) {
        const entry = document.createElement("div");
        entry.textContent = date + " · " + format.format(player.days[date].total);
        timeline.append(entry);
      }
      name.append(timeline);
      row.insertCell().textContent = neighbor ? neighbor.distance.toFixed(1).replace(".", ",") + " campos" : "—";
      const todayCell = row.insertCell();
      const reading = player.days[today];
      todayCell.textContent = reading ? format.format(reading.total) : "Sem leitura";
      if (reading?.increasedAt) {
        const observed = document.createElement("small");
        observed.textContent = "Aumento observado às " + clock(reading.increasedAt, state.zone ?? "Europe/Lisbon");
        todayCell.append(observed);
      }
      row.insertCell().textContent = previous ? previous + " · " + format.format(player.days[previous].total) : "Sem dados";
      const signal = activitySignal(reading, neighbor?.changedAt);
      row.insertCell().textContent = signal.symbol + " " + signal.detail;
      const cell = row.insertCell();
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = player.tracked ?? (!!neighbor || owners.has(player.name));
      toggle.setAttribute("aria-label", "Acompanhar " + player.name);
      toggle.onchange = () => {
        try {
          const latest = readRanking();
          latest[id] ??= {name:player.name, days:{}};
          latest[id].tracked = toggle.checked;
          saveRanking(latest);
          renderRanking();
        } catch { rankStatus("Não foi possível guardar a seleção."); }
      };
      cell.append(toggle);
    }
  }

  async function captureRanking(date) {
    const entries = new Map();
    function collect(rows) {
      for (const entry of rows) {
        const key = entry.id + "/" + entry.date;
        if (!entries.has(key) || entries.get(key).total < entry.total) entries.set(key,entry);
      }
    }
    collect(rankingEntries(document,location.href,date));
    if (!demo) {
      let url = gameUrl("ranking", {mode:"in_a_day", type:"loot_res"});
      const visited = new Set();
      for (let pageNo = 0; url && pageNo < 6; pageNo++) {
        visited.add(String(url));
        const response = await fetch(url, {credentials:"same-origin", signal:AbortSignal.timeout(10000)});
        if (!response.ok) {
          if (entries.size) break;
          throw Error("Classificação indisponível (HTTP " + response.status + ").");
        }
        const page = new DOMParser().parseFromString(await response.text(), "text/html");
        collect(rankingEntries(page,response.url,date));
        const pageIndex = link => Number(link.searchParams.get("page") ?? link.searchParams.get("offset") ?? 0);
        const next = [...page.querySelectorAll('a[href*="in_a_day"]')].map(link => new URL(link.getAttribute("href"), url))
          .filter(link => link.origin === location.origin && link.searchParams.get("screen") === "ranking" &&
            link.searchParams.get("mode") === "in_a_day" && link.searchParams.get("type") === "loot_res" &&
            pageIndex(link) > pageIndex(url) && !visited.has(String(link)))
          .sort((a,b) => pageIndex(a) - pageIndex(b))[0];
        url = next;
      }
    }
    if (!entries.size) throw Error("Nenhum total diário reconhecido na classificação.");
    if (date !== rankingDate()) throw Error("Mudou o dia no servidor. Repete o scan.");
    let history = readRanking();
    const grouped = Map.groupBy(entries.values(), entry => entry.date);
    const at = Date.now();
    for (const [entryDate, records] of grouped) {
      const fresh = entryDate === date ? records : records.filter(entry => (history[entry.id]?.days?.[entryDate]?.total ?? -1) < entry.total);
      history = mergeRanking(history,fresh,entryDate,at);
    }
    saveRanking(history);
    return {today:grouped.get(date)?.length ?? 0, total:entries.size};
  }

  function selectView(name) {
    root.querySelectorAll("[data-pane]").forEach(pane => { pane.hidden = pane.dataset.pane !== name; });
    root.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === name)));
  }

  async function scanAll() {
    const button = $("scan");
    if (button.disabled) return;
    button.disabled = true;
    $("radius").disabled = true;
    $("scan-status").textContent = "A ler aldeias e classificação…";
    const date = rankingDate();
    try {
      const [map, ranking] = await Promise.allSettled([game ? refreshNearby() : Promise.resolve(readNearby()), captureRanking(date)]);
      if (ranking.status === "fulfilled") rankStatus(quantity(ranking.value.total,"registo com data","registos com data") + " na classificação · " + date);
      else rankStatus(ranking.reason.message);
      renderNative();
      renderRanking();
      calculate();
      queueMapMarkers();
      const details = [];
      if (map.status === "fulfilled" && map.value) details.push(quantity(Object.keys(map.value.players).length,"vizinho","vizinhos"));
      if (ranking.status === "fulfilled") details.push(quantity(ranking.value.today,"total de hoje","totais de hoje"));
      if (map.status === "rejected") details.push("Mapa: " + map.reason.message);
      if (ranking.status === "rejected") details.push("Classificação: " + ranking.reason.message);
      $("scan-status").textContent = details.join(" · ");
    } finally {
      button.disabled = false;
      $("radius").disabled = false;
    }
  }
  $("scan").onclick = scanAll;
  root.querySelectorAll("[data-view]").forEach(button => button.onclick = () => selectView(button.dataset.view));
  $("tracked-only").onchange = renderRanking;
  $("export-ranking").onclick = () => {
    try { downloadJson("historico-diario-de-saque.json", readRanking()); }
    catch { rankStatus("Não foi possível exportar o histórico."); }
  };

  $("controls").addEventListener("submit", event => { event.preventDefault(); calculate(); });
  root.querySelectorAll("[data-sort]").forEach(button => button.addEventListener("click", () => {
    const column = button.dataset.sort;
    reverse = column === sort && !reverse;
    sort = column;
    renderPlan();
  }));
  $("close").onclick = () => dialog.close();
  $("capture").hidden = demo;
  $("capture").onclick = captureTargets;
  $("example").onclick = () => { writeEditor(sample(Date.now())); message("Exemplo no editor. Guardar dados substitui os dados atuais."); };
  $("save").onclick = () => {
    try { commit(JSON.parse($("json").value)); }
    catch (error) { message("Dados não guardados. " + error.message); }
  };
  $("file").onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw Error("O tamanho máximo é de 5 MB.");
      writeEditor(validate(JSON.parse(await file.text())));
      message("Ficheiro validado. Clica em Guardar dados para aplicar.");
    } catch (error) { message("Falha na importação. " + error.message); }
    event.target.value = "";
  };
  function downloadJson(filename, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:"application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("export").onclick = () => downloadJson("plano-de-saque-dados.json", state);
  launch.onclick = () => {
    calculate();
    renderNative();
    renderRanking();
    dialog.showModal();
  };
  writeEditor(state);
  $("radius").value = String(readNearby()?.radius ?? 10);
  calculate();
  renderNative();
  renderRanking();
  startMapMarkers();
  selectView(screen === "ranking" || screen === "map" ? "neighbors" : "farm");
  if (screen !== "map" || !readNearby()) dialog.showModal();
})();


