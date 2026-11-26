import { analyzeCooking } from "./cooking.mjs";

const legacyWater = { id: "water", name: "水", seasoning: false, liquid: true };

export function readRecipe(demo, payload) {
  const method = demo.methods.find((item) => item.id === payload?.method);
  if (!method || !Array.isArray(payload.items) || payload.items.length > demo.ingredients.length) return null;
  const intensity = payload.intensity;
  if (!Number.isInteger(intensity) || (method.adjustable ? intensity < 0 || intensity > 100 : intensity !== 0)) return null;
  const items = [];
  const used = new Set();
  for (const entry of payload.items) {
    const food = demo.ingredients.find((item) => item.id === entry?.id) || (entry?.id === "water" ? legacyWater : null);
    if (!food || used.has(food.id) || !Number.isSafeInteger(entry.amount) || entry.amount < 0 ||
        (food.seasoning ? entry.amount > 100 : entry.amount > 1_000_000)) return null;
    const staleAmount = entry.staleAmount ?? 0;
    if (!Number.isSafeInteger(staleAmount) || staleAmount < 0 ||
        staleAmount > entry.amount || (food.seasoning && staleAmount !== 0)) return null;
    used.add(food.id);
    if (entry.amount > 0)
      items.push({ id: food.id, name: food.name, seasoning: food.seasoning, liquid: food.liquid, premium: food.premium === true, amount: entry.amount, staleAmount });
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

export function foodTraits(recipe, storedOvernight = false) {
  const cooked = analyzeCooking(recipe);
  const amount = id => recipe.items.find(item => item.id === id)?.amount || 0;
  const portionScale = 1 + Math.max(0, cooked.mainCount - 1) * .42;
  const liquid = cooked.inBroth ? .42 + amount("stock") * .37 : 0;
  const measured = id => amount(id) / (portionScale + liquid);
  const saltLoad = measured("salt") + measured("soy") * .64;
  const salty = saltLoad >= 55;
  const overpowering = [measured("chili"), measured("sugar"), measured("vinegar")].filter(value => value >= 82).length;
  const greasy = amount("oil") / portionScale >= 82 && !cooked.crispFrying && !cooked.inBroth;
  const ruined = cooked.noHeat || cooked.raw || cooked.scorched || cooked.waterInOil || saltLoad >= 77 || overpowering >= 2;
  const food = recipe.items.filter(item => !item.seasoning);
  const staleServings = food.reduce((total, item) => total + (item.staleAmount || 0), 0);
  const staleShare = storedOvernight ? 1 : staleServings / Math.max(1, food.reduce((total, item) => total + item.amount, 0));
  const strongFlavor = measured("chili") * .95 + measured("black_pepper") * .9 + measured("garlic") * .75 +
    measured("vinegar") * (cooked.lostVinegarAroma ? .22 : .55) + measured("soy") * .43 +
    measured("rosemary") * .4 + measured("cilantro") * .3 + measured("sugar") * .28;
  const staleTaste = staleShare > 0 && strongFlavor < 40 + staleShare * 28;
  const mainStale = staleTaste ? (storedOvernight ? food.find(item => !item.liquid) :
    food.reduce((worst, item) => (item.staleAmount || 0) > (worst?.staleAmount || 0) ? item : worst, null)) : null;
  return {
    ...cooked, ruined, salty, staleTaste, staleIngredient: mainStale?.id,
    texturePenalty: Math.max(cooked.texturePenalty, salty ? 29 : 0, greasy ? 13 : 0,
      cooked.oilFreeFrying && !cooked.crispFrying ? 16 : 0, storedOvernight && cooked.finalDry ? 12 : 0),
    spicy: measured("chili") >= 39,
    sweet: measured("sugar") >= 53,
    peppered: measured("black_pepper") >= 26,
    greasy,
    crispFrying: cooked.crispFrying && !storedOvernight && !ruined,
    western: cooked.western || (cooked.cookedNoodles && amount("garlic") > 0 &&
      !amount("chicken") && !amount("free_range_chicken") && !amount("soy")),
  };
}

export function readDish(demo, payload) {
  const recipe = readRecipe(demo, payload?.recipe);
  if (!recipe || typeof payload.description !== "string" || payload.description.length > 150) return null;
  const offered = recipe.items.reduce((total, item) => total + (item.seasoning || item.liquid ? 0 : item.amount), 0);
  if (payload.portionCount != null) {
    const { portionCount, acceptedUnits, remainingUnits, appetitePortions } = payload;
    if (![portionCount, acceptedUnits, remainingUnits, appetitePortions].every(Number.isSafeInteger) ||
        portionCount < 1 || portionCount > 4 || appetitePortions < 3 || appetitePortions > 7 ||
        acceptedUnits < 0 || remainingUnits < 0 || acceptedUnits > offered * 12 / portionCount ||
        acceptedUnits + remainingUnits > appetitePortions * 12) return null;
    return { description: payload.description, recipe, storedOvernight: payload.storedOvernight === true,
      meal: { offered: offered / portionCount, accepted: acceptedUnits / 12, remaining: remainingUnits / 12 } };
  }
  if (!payload.offeredPortions) return { description: payload.description, recipe };
  const accepted = payload.acceptedPortions;
  const remaining = payload.mealRemaining;
  if (offered !== payload.offeredPortions || !Number.isInteger(accepted) || !Number.isInteger(remaining) ||
      accepted < 0 || remaining < 0 || accepted > offered || accepted + remaining > 6) return null;
  return { description: payload.description, recipe, meal: { offered, accepted, remaining } };
}

export function atePremiumDish(dish) {
  return Boolean(dish && (!dish.meal || dish.meal.accepted > 0) &&
    dish.recipe.items.some(item => item.premium));
}

export function freshnessImpression(ingredient) {
  switch (ingredient) {
    case "uni": return "海胆入口少了鲜甜，余味有点涩。";
    case "geoduck": return "蚌肉少了脆劲，嚼到后面有股闷腥。";
    case "iberico_ham": return "火腿的油脂香有点散，后味发闷。";
    case "shrimp": return "虾肉松软，咽下去有股腥味一直挂着。";
    case "crucian_carp": return "鱼肉吃着发散，嘴里留着一层不太舒服的腥气。";
    case "salmon": return "鱼肉少了该有的紧实感，尾味有点闷腥。";
    case "duck":
    case "pork": return "肉香上不来，嚼完后嘴里还粘着一股发闷的油味。";
    case "free_range_chicken":
    case "chicken":
    case "beef": return "刚入口还能尝到调味，嚼久了有一股不舒服的闷味。";
    case "rice":
    case "sushi_rice":
    case "noodles": return "主食入口不够利落，嚼着有一点黏滞的余味。";
    case "stock":
    case "water": return "汤汁的香味散得很快，舌根有一点发闷。";
    default: return "菜的清香很弱，嚼开后有一点不该有的酸涩。";
  }
}

export function recipeFault(recipe, storedOvernight = false) {
  const traits = foodTraits(recipe, storedOvernight);
  const names = fault => traits.states.find(entry => entry.fault === fault);
  if (traits.waterInOil) return "油和汤水混在一起，表面软塌，炸不出脆壳。";
  if (traits.raw) {
    const entry = names("raw");
    return entry.lot.item.name + entry.text + "。";
  }
  if (traits.garlicScorched) return "蒜发黑，整口带着焦苦味。";
  if (traits.sugarScorched) return "糖熬过了，表面发黑发苦。";
  if (traits.scorched) {
    const entry = names("burnt");
    return entry.lot.item.name + entry.text + "。";
  }
  if (traits.salty) return "入口太咸，原本的鲜味被盖住了。";
  if (traits.noHeat) return "刚摆好盘，食材还没受热。";
  return "调味太重，原本的味道被盖住了。";
}

export function recipeFacts(recipe, storedOvernight = false) {
  const traits = foodTraits(recipe, storedOvernight);
  const prioritized = traits.states.slice().sort((a, b) => b.penalty - a.penalty || b.lot.amount - a.lot.amount);
  const fault = traits.ruined ? recipeFault(recipe, storedOvernight) : "";
  const seen = new Set();
  const texture = [];
  for (const entry of prioritized) {
    const text = storedOvernight && traits.finalDry && entry.text.startsWith("外层脆")
      ? "外层回软了，少了脆劲" : entry.text;
    const line = entry.lot.item.name + text;
    if (seen.has(line) || fault.includes(line)) continue;
    seen.add(line);
    texture.push(line);
    if (texture.length >= 3) break;
  }

  const notes = [
    fault,
    texture.length ? texture.join("，") + "。" : "",
    traits.salty && !traits.ruined ? "入口偏咸。" : "",
    traits.oilFreeFrying && !traits.crispFrying ? "油量偏少，外表没有炸酥。" : "",
    traits.greasy ? "入口有些油腻。" : "",
    traits.spicy ? "辣味明显。" : "",
    traits.sweet ? "甜味明显。" : "",
    traits.freshPepper ? "胡椒香很鲜明。" : traits.peppered ? "胡椒辛香混在底味里。" : "",
    traits.freshHerbs ? "还能闻到葱或香菜的清香。" :
      traits.mellowHerbs ? "葱或香菜的清香变淡，混进了底味。" : "",
    traits.freshVinegar ? "醋香清楚。" : traits.lostVinegarAroma ? "还有酸味，醋香比较淡。" : "",
    traits.fromStock ? (traits.inBroth ? "汤汁鲜味明显。" : "底味带有汤汁的鲜香。") : "",
    traits.staleTaste ? freshnessImpression(traits.staleIngredient) : "",
  ];
  return notes.filter(Boolean).join("");
}

export function mockCook(recipe, storedOvernight = false) {
  return { name: "料理", description: recipeFacts(recipe, storedOvernight).slice(0, 150) };
}

export function foodEnjoyment(context, recipe, reaction, storedOvernight) {
  const traits = foodTraits(recipe, storedOvernight);
  const { guest } = context;
  if (traits.ruined || (guest.id === "jack" && traits.chickenNoodles)) return 0;
  if (traits.staleTaste)
    return reaction === "awful" ? 0 : Math.min(38, { dislike: 23, steady: 38 }[reaction] ?? 38);
  let enjoyment;
  if (reaction) enjoyment = { awful: 0, dislike: 23, steady: 52, liked: 81, full: 100 }[reaction] ?? 52;
  else if (guest.id === "jack") enjoyment = traits.western ? 83 : 26;
  else if (traits.spicy && ["lin", "zhou"].includes(guest.id)) enjoyment = 30;
  else enjoyment = guest.likes && traits[guest.likes] ? 95 : 70;
  return Math.min(enjoyment, 100 - traits.texturePenalty);
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
    const traits = foodTraits(servedDish.recipe, servedDish.storedOvernight);
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
  const meal = servedDishes.at(-1)?.meal;
  const satisfied = meal ? meal.remaining === 0 && satisfaction >= 1 : satisfaction >= 2;
  const departure = tension >= limit ? "unhappy"
    : servedDishes.length && satisfied && tension === 0 ? "satisfied" : "";
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
  const traits = foodTraits(context.servedDish.recipe, context.servedDish.storedOvernight);
  if (traits.ruined || (context.guest.id === "jack" && traits.chickenNoodles)) return "awful";
  if (traits.staleTaste || (context.guest.id === "jack" && !traits.western)) return "dislike";
  if (traits.texturePenalty >= 24 || (traits.spicy && ["lin", "zhou"].includes(context.guest.id))) return "dislike";
  if (traits.texturePenalty >= 16) return "steady";
  if (atePremiumDish(context.servedDish) &&
      context.servedDish.recipe.items.some(item => context.guest.premiumFavorites?.includes(item.id))) return "full";
  if (context.guest.likes && traits[context.guest.likes]) return "full";
  return "liked";
}

export function farewell(guestId, kind) {
  if (kind === "satisfied") return guestId === "jack" ? "我吃够了。告辞。" : "吃得很满足，今天就到这儿吧。";
  return guestId === "yano" ? "多谢招待。我还有点事，先告辞了。"
    : guestId === "jack" ? "我走了。" : "抱歉，我想先离开。";
}
