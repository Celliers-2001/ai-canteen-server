// Times are compressed for play. These coefficients model texture and heat transfer, not food safety.
const methods = {
  fry: { heat: 1.08, brown: 1, dry: 1.1 },
  stirfry: { heat: 1.18, brown: .82, dry: .9 },
  roast: { heat: .82, brown: 1, dry: 1.0 },
  deep_fry: { heat: 1.28, brown: 1.23, dry: 1.5 },
  boil: { heat: 1.05, absorb: 1, damp: .9 },
  steam: { heat: .95, absorb: .57, damp: .6 },
  stew: { heat: .8, absorb: .93, damp: .8 }
};

// Each group has a different heating or hydration window. It also changes what happens past that window.
const profiles = {
  chicken:  ["poultry", 12], free_range_chicken: ["poultry", 13], duck: ["poultry", 14],
  beef: ["beef", 9], wagyu: ["beef", 8], pork: ["pork", 11],
  shrimp: ["denseSeafood", 5], geoduck: ["coldSeafood", 4.5],
  salmon: ["coldFish", 7], crucian_carp: ["fish", 8],
  softshell_turtle: ["stewMeat", 17], egg: ["egg", 6],
  foie_gras: ["liver", 7], uni: ["delicate", 3], caviar: ["delicate", 2], iberico_ham: ["cured", 4],
  rice: ["rice", 15], sushi_rice: ["rice", 14], noodles: ["noodles", 8.5], glass_noodles: ["noodles", 5.5],
  potato: ["root", 12], radish: ["root", 9], bamboo_shoot: ["root", 8],
  tomato: ["tomato", 4.5], cucumber: ["crispVegetable", 4], onion: ["onion", 6],
  lettuce: ["leaf", 2.5], bitter_melon: ["crispVegetable", 6],
};

const simmering = new Set(["boil", "stew"]);
const airHeat = new Set(["fry", "stirfry", "roast", "deep_fry"]);
const readyCold = new Set(["leaf", "tomato", "crispVegetable", "onion", "cured", "coldFish", "coldSeafood", "delicate"]);

function record(item, amount) {
  return { item, amount, heat: 0, hydration: 0, wet: 0, stew: 0, moisture: 0, brown: 0, crust: 0, friedCrust: 0, dry: 0 };
}

function cookInLiquid(lot, time, style, method) {
  lot.wet += time;
  lot.hydration += time * style.absorb;
  lot.moisture = Math.min(4, lot.moisture + time * style.damp);
  lot.crust = Math.max(0, lot.crust - time * 1.2);
  lot.friedCrust = Math.max(0, lot.friedCrust - time * 1.2);
  if (method === "stew") lot.stew += time;
}

function heatBatch(pan, time) {
  const method = pan.method;
  const style = methods[method];
  if (!style || time <= 0) return;

  // Surface effects lag behind the switch from a bath of water to dry heat.
  const mains = pan.lots.reduce((sum, lot) => sum + (!lot.item.seasoning && !lot.item.liquid ? lot.amount : 0), 0);
  const oil = pan.oil;
  const validFry = method === "deep_fry" && oil >= 18 + Math.min(10, mains) * 4 && pan.liquid === 0;
  const crowded = airHeat.has(method) && mains > 3;
  const load = crowded ? Math.max(.67, 1 - (mains - 3) * .035) : 1;
  const liquidTime = !style.absorb && pan.liquid > 0 ? Math.min(time, pan.liquid * 2.8) : 0;
  if (method === "deep_fry") {
    pan.shortOnOil ||= oil < 18 + Math.min(10, mains) * 4;
    pan.waterInOil ||= pan.liquid > 0;
  }

  for (const lot of pan.lots) {
    lot.heat += time * style.heat * load * (method === "deep_fry" && !validFry ? .58 : 1);
    if (style.absorb) {
      cookInLiquid(lot, time, style, method);
      continue;
    }
    if (liquidTime > 0) {
      cookInLiquid(lot, liquidTime, methods.boil, method);
      if (method === "deep_fry") {
        lot.crust *= .18;
        lot.friedCrust *= .18;
      }
    }
    const dryTime = time - liquidTime;
    const afterDrying = Math.max(0, dryTime - lot.moisture / style.dry);
    lot.moisture = Math.max(0, lot.moisture - dryTime * style.dry);
    const color = afterDrying * style.brown * load * (method === "deep_fry" && !validFry ? .22 : 1);
    lot.brown += color;
    lot.dry += afterDrying * load;
    lot.crust += color * (validFry ? 1.24 : .43);
    if (validFry) lot.friedCrust += color * 1.24;
  }

  if (simmering.has(method) && pan.stock > 0 && mains > 0) pan.stockTime += time;
  if (!style.absorb) pan.liquid = Math.max(0, pan.liquid - liquidTime / 2.8);
  pan.lastHeat = method;
}

function simulate(recipe) {
  const steps = recipe.steps || [
    { atMs: 0, method: recipe.method },
    ...recipe.items.map(item => ({ atMs: 0, item, amount: item.amount }))
  ];
  const elapsedMs = recipe.steps ? recipe.elapsedMs : recipe.intensity * 200;
  const pan = { lots: [], method: recipe.method.id, lastHeat: "", oil: 0, liquid: 0, stock: 0, stockTime: 0,
    shortOnOil: false, waterInOil: false };
  let from = 0;
  for (const step of steps) {
    heatBatch(pan, (step.atMs - from) / 1000);
    if (step.method) {
      const next = step.method.id;
      if (airHeat.has(next) && simmering.has(pan.method)) pan.liquid = 0;
      pan.method = next;
    } else {
      if (step.item.id === "oil") pan.oil += step.amount;
      if (step.item.liquid) {
        pan.liquid += step.amount;
        if (step.item.id === "stock") pan.stock += step.amount;
      }
      pan.lots.push(record(step.item, step.amount));
    }
    from = step.atMs;
  }
  heatBatch(pan, (elapsedMs - from) / 1000);
  return pan;
}

function state(lot, coldFinish) {
  const [type, target] = profiles[lot.item.id] || ["root", 9];
  const ratio = lot.heat / target;
  const result = (text, penalty = 0, fault = "") => ({ lot, text, penalty, fault });
  if (type === "rice" || type === "noodles") {
    if (lot.hydration < target * .48) return result("干硬夹生", 46, "raw");
    if (lot.hydration < target * .86) return result("里面还有些硬芯", 22);
    if (lot.hydration > target * 1.65) return result(type === "rice" ? "吸水太多，黏成一团" : "泡软了，挑起来容易断", 23);
    if (lot.brown > 19) return result("表面焦硬发苦", 48, "burnt");
    return result(lot.crust >= 3.5 ? "外面有一层干香，芯里已经吸足水" : type === "rice" ? "吸足水分，米粒柔软有弹性" : "软弹，还有一点咬劲");
  }

  if (lot.heat < .35 && readyCold.has(type)) {
    return result(type === "leaf" || type === "crispVegetable" ? "清脆爽口" :
      type === "cured" ? "咸鲜，脂香清楚" : type === "onion" ? "脆，带点辛香" :
        type === "coldSeafood" ? "清鲜脆嫩" : type === "tomato" ? "酸甜多汁" : "口感细嫩，鲜味清楚");
  }

  // Beef is treated as thin whole cuts. A cooked surface with a tender centre is a valid result in this game.
  const beefReady = type === "beef" && ratio >= .60 && lot.brown >= 3.5;
  if (!readyCold.has(type) && type !== "root" && ratio < .94 && !beefReady)
    return result(type === "egg" ? "蛋液还没有凝住" : "里面还偏生", 48, "raw");
  if ((type === "coldFish" || type === "coldSeafood") && ratio < .86)
    return result(coldFinish && lot.heat < 1 ? "温凉，口感有些软散" : "受热不匀，里面偏生", 32,
      coldFinish && lot.heat < 1 ? "" : "raw");

  const burnAt = type === "leaf" || type === "delicate" ? 10 : type === "egg" ? 15 :
    type === "root" ? 26 : type === "beef" || type === "pork" ? 20 : 18;
  if (lot.brown > burnAt)
    return result("表面焦黑，有苦味", 52, "burnt");
  if (type === "root" && ratio < .83)
    return result(lot.heat < .35 ? "还是生硬的" : "外面软了，中心仍发硬", lot.heat < .35 ? 32 : 20);
  if (type === "stewMeat" && lot.stew < 18)
    return result("熟了，但还没炖软，嚼起来费劲", 22);
  const isMeat = ["poultry", "pork", "beef", "stewMeat"].includes(type);
  if (isMeat && lot.stew >= 42)
    return result("炖得太久，肉纤维已经散开", 19);
  if (isMeat && lot.stew >= 17)
    return result("炖得软润，肉质容易分开");
  if (isMeat && lot.wet > lot.dry && ratio >= 2.2)
    return result("外面带着汁水，里面的肉纤维偏紧", 21);
  if (type === "root" && lot.wet > target * 2.2)
    return result("煮得过软，边缘容易散开", 17);
  if (type === "leaf") return ratio > 2.4
    ? result("已经塌软，水味偏重", 18) : result("叶子微软，仍带一点脆");
  if (type === "tomato") return ratio > 1.4
    ? result("软烂出汁，酸甜融进汤汁") : result("刚出汁，还保留果肉");
  if (type === "onion") return lot.brown >= 4
    ? result("转甜，边缘带一点焦香") : result("辛味变轻，仍有一点脆");
  if (type === "crispVegetable" && ratio > 2.4) return result("失去脆劲，嚼起来偏软", 17);
  if ((type === "denseSeafood" || type === "coldSeafood") && ratio > 1.5)
    return result("肉质收紧发韧，鲜甜变淡", 27);
  if ((type === "fish" || type === "coldFish") && ratio > 1.65)
    return result(lot.wet > lot.dry ? "发散易碎，鲜味进了汁水" : "肉质发柴，油润感变弱", 24);
  if ((type === "liver" || type === "delicate" || type === "cured") && ratio > 1.4)
    return result(type === "liver" ? "油脂析出太多，里面有些干" :
      type === "delicate" ? "鲜香变淡，质地发紧" : "油脂析出，咸香偏重", 26);
  if (type === "egg") return ratio > 1.9
    ? result("凝得太紧，入口发韧", 18) : result("刚刚凝住，口感嫩");
  if (lot.dry > target * 1.52 && type !== "root")
    return result("外边变硬，里面偏干", 22);
  if (lot.crust >= 5 && lot.moisture < .8) return result("外层脆，里面仍保留水分");
  if (lot.moisture >= 2 && lot.brown >= 3.5) return result("表面已回软，留有一点焦香");
  if (type === "beef" && ratio < 1.1 && lot.brown >= 3.5)
    return result("外面有煎香，切面偏嫩");
  if (lot.brown >= 3.5) return result(type === "root" ? "表面有焦香，里面绵软" : "外层干香，内部熟透");
  if (lot.wet >= 2) return result(type === "fish" || type === "coldFish" ? "肉质湿润，轻轻一拨就分开" : type === "root" ? "中心煮软，水分充足" : "质地湿润，口感柔和");
  return result(type === "denseSeafood" ? "肉质紧实带弹，鲜甜还在" : "质地保留弹性");
}

const cache = new WeakMap();

export function analyzeCooking(recipe) {
  const cached = cache.get(recipe);
  if (cached) return cached;
  const pan = simulate(recipe);
  const coldFinish = !recipe.method.adjustable;
  const mains = pan.lots.filter(lot => !lot.item.seasoning && !lot.item.liquid);
  const states = mains.map(lot => state(lot, coldFinish));
  const mainCount = mains.reduce((count, lot) => count + lot.amount, 0);
  const any = (id, condition) => mains.some(lot => lot.item.id === id && condition(lot));
  const stages = (ids, condition) => ids.some(id => any(id, condition));
  const readyRice = states.some(entry => (entry.lot.item.id === "sushi_rice" || entry.lot.item.id === "rice") && entry.penalty < 10);
  const coldSalmon = any("salmon", lot => lot.heat < .35);
  const stock = pan.stockTime >= 2;
  const inBroth = !coldFinish && pan.lastHeat !== "" && simmering.has(pan.lastHeat);
  const flavor = id => pan.lots.filter(lot => lot.item.id === id);
  const late = (ids, time) => ids.some(id => flavor(id).some(lot => lot.heat < time));
  const long = ids => ids.some(id => flavor(id).some(lot => lot.heat >= 7));
  const garlicScorched = flavor("garlic").some(lot => lot.amount >= 12 && lot.dry >= 9 && lot.brown >= 7);
  const sugarScorched = flavor("sugar").some(lot => lot.amount >= 18 && lot.dry >= 12 && lot.brown >= 10);
  const mixed = {
    states,
    noHeat: pan.lastHeat === "" && recipe.method.adjustable,
    raw: states.some(entry => entry.fault === "raw"),
    scorched: states.some(entry => entry.fault === "burnt") || garlicScorched || sugarScorched,
    garlicScorched, sugarScorched,
    texturePenalty: Math.max(0, ...states.map(entry => entry.penalty)),
    mainCount,
    wet: mains.some(lot => lot.wet >= 2),
    finalDry: !coldFinish && mains.some(lot => lot.crust >= 1.1 && lot.moisture <= 1.5),
    crispFrying: !coldFinish && pan.lastHeat === "deep_fry" && mains.some(lot => lot.friedCrust >= 5 && lot.moisture < .8),
    oilFreeFrying: pan.shortOnOil,
    waterInOil: pan.waterInOil,
    stock, inBroth,
    chickenNoodles: inBroth &&
      stages(["chicken", "free_range_chicken"], lot => lot.wet >= 3) && any("noodles", lot => lot.wet >= 3),
    fromStock: stock,
    freshHerbs: late(["cilantro", "scallion"], 2.6),
    mellowHerbs: long(["cilantro", "scallion"]),
    freshPepper: late(["black_pepper"], 2.2),
    lostVinegarAroma: long(["vinegar"]) && !late(["vinegar"], 2.2),
    freshVinegar: late(["vinegar"], 2.2),
    western: stages(["beef", "wagyu"], lot => lot.brown >= 3.5) || any("iberico_ham", () => true) ||
      states.some(entry => entry.lot.item.id === "foie_gras" && entry.penalty < 20),
    cookedNoodles: any("noodles", lot => lot.hydration >= 7.31),
    sushi: coldFinish && coldSalmon && readyRice,
  };
  cache.set(recipe, mixed);
  return mixed;
}
