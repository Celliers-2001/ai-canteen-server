export function readRecipe(demo, payload) {
  const method = demo.methods.find((item) => item.id === payload?.method);
  if (!method || !Array.isArray(payload.items) || payload.items.length > demo.ingredients.length) return null;
  const intensity = payload.intensity;
  if (!Number.isInteger(intensity) || (method.adjustable ? intensity < 0 || intensity > 100 : intensity !== 0)) return null;
  const items = [];
  const used = new Set();
  for (const entry of payload.items) {
    const food = demo.ingredients.find((item) => item.id === entry?.id);
    if (!food || used.has(food.id) || !Number.isSafeInteger(entry.amount) || entry.amount < 0 ||
        (food.seasoning ? entry.amount > 100 : entry.amount > 1_000_000)) return null;
    const staleAmount = entry.staleAmount ?? 0;
    if (!Number.isSafeInteger(staleAmount) || staleAmount < 0 ||
        staleAmount > entry.amount || (food.seasoning && staleAmount !== 0)) return null;
    used.add(food.id);
    if (entry.amount > 0)
      items.push({ id: food.id, name: food.name, seasoning: food.seasoning, liquid: food.liquid, amount: entry.amount, staleAmount });
  }
  if (!items.some((item) => !item.seasoning && !item.liquid)) return null;

  const recipe = { method, intensity, items };
  if (payload.steps == null || (Array.isArray(payload.steps) && payload.steps.length === 0))
    return !payload.elapsedMs ? recipe : null;

  const elapsedMs = payload.elapsedMs;
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 2_147_483_647 ||
      !Array.isArray(payload.steps) || payload.steps.length > 1024) return null;

  const itemById = new Map(items.map(item => [item.id, item]));
  const added = new Map();
  const steps = [];
  let currentMethod = null;
  let lastTime = 0;
  for (const step of payload.steps) {
    if (!step || !Number.isInteger(step.atMs) || step.atMs < lastTime || step.atMs > elapsedMs) return null;
    lastTime = step.atMs;
    if (step.method) {
      currentMethod = demo.methods.find(item => item.id === step.method);
      if (!currentMethod || step.id || step.amount) return null;
      steps.push({ atMs: lastTime, method: currentMethod });
    } else {
      const item = itemById.get(step.id);
      if (!currentMethod || !item || !Number.isInteger(step.amount) || step.amount <= 0) return null;
      const total = (added.get(item.id) || 0) + step.amount;
      if (total > item.amount) return null;
      added.set(item.id, total);
      steps.push({ atMs: lastTime, item, amount: step.amount });
    }
  }

  if (!steps[0].method || steps[0].atMs !== 0 || currentMethod.id !== method.id ||
      items.some(item => added.get(item.id) !== item.amount)) return null;
  return { ...recipe, elapsedMs, steps };
}

export function describeRecipe(recipe) {
  if (recipe.steps) {
    const duration = seconds(recipe.elapsedMs);
    const timeline = recipe.steps.map(step => seconds(step.atMs) + "秒 " + (step.method
      ? "切到" + step.method.name
      : "加入" + step.item.name + (step.item.seasoning ? step.amount + "%" : " ×" + step.amount)));
    return "总时长 " + duration + " 秒；" + timeline.join("；") + "；" + duration + " 秒出锅";
  }
  const scale = recipe.method.adjustable ? "（烹饪尺度：" + recipe.intensity + "%）" : "";
  return recipe.method.name + scale + " · " + recipe.items.map((item) =>
    item.name + (item.seasoning ? "（" + item.amount + "%）" : "")).join("、");
}

function seconds(ms) { return (ms / 1000).toFixed(2); }

const proteins = new Set(["chicken", "beef", "duck", "pork", "shrimp", "crucian_carp"]);
const dryMethods = new Set(["fry", "stirfry", "roast", "deep_fry"]);
const wetMethods = new Set(["boil", "stew", "steam"]);
const soupMethods = new Set(["boil", "stew"]);

function timelineTraits(recipe) {
  const methods = recipe.steps.filter(step => step.method);
  const additions = recipe.steps.filter(step => step.item);
  const segments = methods.map((step, index) => ({
    method: step.method,
    from: step.atMs,
    to: methods[index + 1]?.atMs ?? recipe.elapsedMs,
  }));
  const timeAfter = (at, condition) => segments.reduce((sum, segment) => sum +
    (condition(segment.method) ? Math.max(0, segment.to - Math.max(segment.from, at)) : 0), 0);
  const did = id => timeAfter(0, method => method.id === id) > 0;
  const added = id => additions.filter(step => step.item.id === id);
  const heated = at => timeAfter(at, method => method.adjustable);
  const soup = id => added(id).some(step => timeAfter(step.atMs, method => soupMethods.has(method.id)) >= 2000);
  const last = segments.findLast(segment => segment.to > segment.from)?.method || recipe.method;
  return {
    noHeat: heated(0) === 0 && last.adjustable,
    raw: additions.some(step => proteins.has(step.item.id) && heated(step.atMs) <= 4000),
    overcooked: additions.some(step => !step.item.seasoning && !step.item.liquid &&
      timeAfter(step.atMs, method => dryMethods.has(method.id)) >= 18000),
    deepFrying: did("deep_fry"),
    finalDry: dryMethods.has(last.id) && timeAfter(0, method => dryMethods.has(method.id)) >= 1200,
    wet: timeAfter(0, method => wetMethods.has(method.id)) >= 2500,
    fromStock: soup("stock"),
    chickenNoodles: soup("chicken") && soup("noodles"),
    coldSalmon: added("salmon").some(step => heated(step.atMs) === 0),
    westernBeef: added("beef").some(step => timeAfter(step.atMs, method => ["fry", "roast"].includes(method.id)) >= 1500),
    westernNoodles: added("noodles").some(step =>
      timeAfter(step.atMs, method => ["boil", "stirfry"].includes(method.id)) >= 1500),
    freshHerbs: added("cilantro").concat(added("scallion")).some(step => heated(step.atMs) < 2500),
    mellowHerbs: added("cilantro").concat(added("scallion")).some(step => heated(step.atMs) >= 7000),
    freshPepper: added("black_pepper").some(step => heated(step.atMs) < 2500),
  };
}

export function foodTraits(recipe) {
  const amount = (id) => recipe.items.find((item) => item.id === id)?.amount || 0;
  const has = (...ids) => ids.every((id) => amount(id) > 0);
  const timeline = recipe.steps ? timelineTraits(recipe) : null;
  const needsHeat = recipe.items.some(item => proteins.has(item.id));
  const noHeat = timeline?.noHeat ?? (recipe.method.adjustable && recipe.intensity === 0);
  const undercooked = timeline?.raw ?? (needsHeat && (!recipe.method.adjustable || recipe.intensity <= 20));
  const heavy = recipe.items.filter((item) => item.seasoning && item.amount >= 90).length;
  const deepFrying = timeline?.deepFrying ?? (recipe.method.id === "deep_fry");
  const overcooked = timeline?.overcooked ?? (recipe.intensity >= 90 && dryMethods.has(recipe.method.id));
  const salty = amount("salt") >= 90 || (amount("soy") >= 90 && amount("salt") >= 75);
  const ruined = noHeat || undercooked || salty || heavy >= 3 || (overcooked && (deepFrying || !has("water")));
  const food = recipe.items.filter(item => !item.seasoning);
  const staleServings = food.reduce((total, item) => total + (item.staleAmount || 0), 0);
  const staleShare = staleServings / Math.max(1, food.reduce((total, item) => total + item.amount, 0));
  const strongFlavor = amount("chili") * .9 + amount("black_pepper") * .9 + amount("garlic") * .7 +
    amount("vinegar") * .45 + amount("soy") * .35 + amount("rosemary") * .35 +
    amount("cilantro") * .3 + amount("sugar") * .28;
  const staleTaste = staleShare > 0 && strongFlavor < 45 + staleShare * 28;
  return {
    ruined, salty, noHeat, raw: undercooked, overcooked, staleTaste,
    spicy: amount("chili") >= 50,
    sweet: amount("sugar") >= 75,
    peppered: amount("black_pepper") >= 35,
    freshPepper: timeline?.freshPepper,
    freshHerbs: timeline?.freshHerbs,
    mellowHerbs: timeline?.mellowHerbs,
    wet: timeline?.wet,
    finalDry: timeline?.finalDry,
    oilFreeFrying: deepFrying && !has("oil"),
    crispFrying: deepFrying && amount("oil") >= 35,
    greasy: amount("oil") >= 90,
    fromStock: timeline?.fromStock ?? (soupMethods.has(recipe.method.id) && has("stock")),
    chickenNoodles: timeline?.chickenNoodles ?? (soupMethods.has(recipe.method.id) && has("chicken", "noodles")),
    sushi: (timeline?.coldSalmon ?? (!recipe.method.adjustable && has("salmon"))) &&
      (has("sushi_rice") || has("rice", "vinegar")),
    western: (timeline?.westernBeef ?? (has("beef") && ["fry", "roast"].includes(recipe.method.id))) ||
      ((timeline?.westernNoodles ?? (has("noodles") && ["boil", "stirfry"].includes(recipe.method.id))) &&
        has("garlic") && !has("chicken") && !has("soy"))
  };
}

export function readDish(demo, payload) {
  const recipe = readRecipe(demo, payload?.recipe);
  if (!recipe || typeof payload.description !== "string" || payload.description.length > 150) return null;
  return { description: payload.description, recipe };
}

export function recipeFacts(recipe) {
  const traits = foodTraits(recipe);
  const texture = traits.noHeat ? "成品没有热气，食材依然是生的。"
    : traits.raw ? "肉类或水产内部偏生，质地生硬。"
    : traits.overcooked ? "部分食材焦硬发干。"
    : traits.crispFrying && traits.finalDry ? "外层酥脆。"
    : traits.finalDry ? (traits.wet ? "外层干香，里面仍润。" : "外层有干香。")
    : traits.wet ? "食材湿润偏软。" : "";
  const taste = traits.salty ? "咸味过重。"
    : traits.ruined && !traits.noHeat && !traits.raw && !traits.overcooked ? "味道被过重的调味压住。"
    : [traits.spicy ? "明显偏辣。" : "", traits.sweet ? "明显偏甜。" : "",
        traits.freshPepper ? "黑胡椒香鲜明，停在表面。" : traits.peppered ? "带融入汁水的胡椒辛香。" : "",
        traits.freshHerbs ? "葱或香菜的清香明显。" : traits.mellowHerbs ? "青香已经融进底味。" : "",
        traits.oilFreeFrying ? "外层没有形成明显的脆壳。" : "",
        traits.greasy ? "油分偏多，入口发腻。" : "",
        traits.fromStock ? "汁水鲜味明显。" : ""].filter(Boolean).join("");
  const freshness = traits.staleTaste ? "后味有明显陈味，鲜香不足。" : "";
  return texture + taste + freshness || "口味和质地没有明显的失衡。";
}

export function mockCook(recipe) {
  const mains = recipe.items.filter(item => !item.seasoning && !item.liquid).map(item => item.name).join("、");
  return { name: "料理", description: (mains + "的味道仍能辨认。" + recipeFacts(recipe)).slice(0, 150) };
}

export function foodEnjoyment(context, recipe, reaction) {
  const traits = foodTraits(recipe);
  const { guest } = context;
  if (traits.ruined || (guest.id === "jack" && traits.chickenNoodles)) return 0;
  if (traits.staleTaste)
    return reaction === "awful" ? 0 : Math.min(38, { dislike: 23, steady: 38 }[reaction] ?? 38);
  if (reaction) return { awful: 0, dislike: 23, steady: 52, liked: 81, full: 100 }[reaction] ?? 52;
  if (guest.likes && traits[guest.likes]) return 95;
  if (guest.id === "jack") return traits.western ? 83 : 26;
  if (traits.spicy && ["lin", "zhou"].includes(guest.id)) return 30;
  return 70;
}

export function updateVisit(context, reaction) {
  const { guest, visit, event, servedDishes, servedDish } = context;
  let { tension, satisfaction } = context;
  if (event === "arrival") return { tension, satisfaction, departure: "" };

  if (event === "chat") {
    if (reaction === "hurt") tension += 3;
    if (reaction === "uneasy") tension += 1;
    if (reaction === "warm") tension -= 1;
    if (reaction === "full" && servedDishes.length && satisfaction > 0) satisfaction++;
  }
  if (event === "served") {
    const traits = foodTraits(servedDish.recipe);
    if (traits.ruined) tension += guest.id === "yano" ? 2 : 4;
    else if (guest.id === "jack" && traits.chickenNoodles) tension += 3;
    else if (reaction === "awful") tension += guest.id === "yano" ? 1 : 2;
    else if (traits.staleTaste || reaction === "dislike") tension += 1;
    else if (reaction === "liked" || reaction === "full") satisfaction += reaction === "full" ? 2 : 1;
    if (!traits.ruined && !traits.staleTaste && traits.sushi && guest.id === "yano") satisfaction = Math.max(satisfaction, 2);
  }

  tension = Math.min(12, Math.max(0, tension));
  satisfaction = Math.min(12, satisfaction);
  const limit = guest.patience || (guest.id === "yano" ? 4 : guest.id === "jack" ||
    (guest.id === "wang" && visit.id !== "first_order") ? 2 : 3);
  const departure = tension >= limit ? "unhappy"
    : servedDishes.length && satisfaction >= 2 && tension === 0 ? "satisfied" : "";
  return { tension, satisfaction, departure };
}

export function serviceTone(message) {
  const words = message.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, "");
  if (/(?:^|[。，！？,!?])\s*(?:(?:你|您)(?:就是|是|真|给我)?)?(?:滚开|滚出去|滚吧|闭嘴|废物|蠢货|傻子|烦死你|讨厌你)(?:[啊吧了。！!,，]|$)/.test(words))
    return "hurt";
  if (/^(?:别问了|不想理你|随便吧)(?:[。！!，,]|$)/.test(words.trim())) return "uneasy";
  if (/欢迎(?:光临|回来|你|您)|谢谢(?:您|你)?|感谢|辛苦了|对不起|抱歉|不好意思|您(?:好|请|慢|先|别|想|可以)|慢慢(?:吃|来|说)|请(?:问|坐|稍等|慢用)|需要(?:我|帮忙)|为您|给您|喝(?:杯|口)水|等久了|别着急|想吃什么|有忌口/.test(words))
    return "warm";
  return "steady";
}

export function mockReaction(context) {
  if (context.event === "chat")
    return serviceTone(context.history.at(-1).content);
  if (context.event !== "served") return "steady";
  const traits = foodTraits(context.servedDish.recipe);
  if (traits.ruined || (context.guest.id === "jack" && traits.chickenNoodles)) return "awful";
  if (traits.staleTaste || (context.guest.id === "jack" && !traits.western)) return "dislike";
  if (traits.spicy && ["lin", "zhou"].includes(context.guest.id)) return "dislike";
  if (context.guest.likes && traits[context.guest.likes]) return "full";
  return "liked";
}

export function farewell(guestId, kind) {
  if (kind === "satisfied") return guestId === "jack" ? "我吃够了。告辞。" : "吃得很满足，今天就到这儿吧。";
  return guestId === "yano" ? "多谢招待。我还有点事，先告辞了。"
    : guestId === "jack" ? "我走了。" : "抱歉，我想先离开。";
}
