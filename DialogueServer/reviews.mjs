import { serviceTone } from "./kitchen.mjs";

const courtesy = /^(?:(?:您可以|您先|您|请您|请)?(?:您好|你好|欢迎(?:光临|回来|您|你)?|晚上好|早上好|中午好|坐(?:下)?|坐吧|慢用|慢慢吃|稍等(?:一下|一会儿)?|等一下|等等|马上(?:就好)?|快好了|知道了|明白了|行(?:吧|的)?|好(?:的|呀|吧)?|嗯(?:嗯)?|哦|啊|没事|不客气|谢谢(?:您|你)?|感谢(?:您|你)?|辛苦了|再见|慢走|想吃(?:点)?什么(?:呀|吗|呢)?|今天想吃(?:点)?什么|有什么忌口(?:吗)?|吃点什么|稍等一下))+$/u;
const dismisses = /等不了就走|爱吃不吃|不吃就走|没空理你|别来烦我|关我什么事|你就等着|烦不烦/;
const waiting = /还要多久|还得等多久|大概还有多久|还要等一会儿吗|快好了吗|等得有点久|等太久|等了很久|等了半天/;
const acknowledges = /久等|抱歉|不好意思|对不起|理解|让你等|让您等/;
const update = /(?:还(?:要|需|得|差|有)|大概|预计).{0,10}(?:\d+|[一二两三四五六七八九十几半]+).{0,4}(?:秒|分钟|刻钟)|(?:正在|已经|这就|马上|只剩|就差).{0,10}(?:收汁|出锅|上菜|拌好|装盘|盛好|煮熟|炖软|煎好|换一道|先上一份)/;
const apology = /抱歉|不好意思|对不起/;
const corrective = /重做|换(?:一道|一份|个做法)|改成|给(?:你|您)补|先上(?:一点|一份)|把(?:辣椒|香菜|盐)去掉|刚才.{0,10}(?:说重|说错|说得不妥)/;
const complaint = /不合口味|太咸|太辣|太淡|没熟|咬不动|不舒服|说话有点|不喜欢|刚才我说过|说了不要/;
const mealTopics = [
  [/不吃辣|不要辣|怕辣|少辣|不放辣|忌辣/, /不放辣|少放辣|少辣|辣椒单放/],
  [/想吃辣|爱吃辣|辣一点|要辣些/, /多放辣|给.{0,5}做辣|加辣|加点辣/],
  [/少盐|不想太咸|怕咸|淡一点|清淡|少放盐/, /少盐|少放盐|盐少放|清淡|调淡|淡一点/],
  [/不要香菜|不吃香菜|讨厌香菜|香菜少放/, /不放香菜|香菜不放|去(?:掉)?香菜|香菜分开/],
  [/小份|少一点|饭量不大|吃得少|吃不下那么多/, /小份|少盛|少做|做半份|做小一点/],
  [/份量足|分量足|饭量大|多一点|没吃饱/, /加一份|多盛|多做|再做|先加|再上/],
  [/忌口|过敏|不能吃|不吃|不要放/, /分开|不放|换用|换成|忌口|先确认/],
];

function compact(text) {
  return text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
}

export function serviceEvidence(context) {
  let previousGuest = "";
  let ownerLines = 0;
  let evidenceOfNeed = false;
  let waitUpdate = false;
  let waitingForAnswer = false;
  let repairOffered = false;
  let servedAfterRepair = false;
  let rude = false;
  let dismissed = false;
  let prompts = 0;
  const meaningful = new Set();

  for (const { role, content } of context.history) {
    if (role === "assistant") {
      previousGuest = content;
      if (waiting.test(content)) {
        prompts++;
        waitingForAnswer = true;
      }
      continue;
    }
    if (content.startsWith("【上菜】")) {
      if (repairOffered) servedAfterRepair = true;
      continue;
    }

    ownerLines++;
    const tone = serviceTone(content);
    const dismissive = tone === "uneasy" || dismisses.test(content);
    if (tone === "hurt") {
      rude = true;
      repairOffered = servedAfterRepair = false;
      continue;
    }
    if (dismissive) {
      dismissed = true;
      repairOffered = servedAfterRepair = false;
      continue;
    }

    const normal = compact(content);
    if (normal && !courtesy.test(normal)) meaningful.add(normal);
    if (mealTopics.some(([guest, owner]) => guest.test(previousGuest) && owner.test(content)))
      evidenceOfNeed = true;
    if (update.test(content) && (waitingForAnswer || acknowledges.test(content))) {
      waitUpdate = true;
      waitingForAnswer = false;
    }
    if (apology.test(content) && corrective.test(content) &&
        (complaint.test(previousGuest) || waiting.test(previousGuest) || rude || dismissed))
      repairOffered = true;
  }

  const waitPrompts = context.waitPrompts ?? Math.min(prompts, 2);
  const leftWaiting = context.leftWaiting ?? (context.reason === "unhappy" && !context.servedDishes.length &&
    context.history.some(line => line.role === "assistant" && /等得有点久|等太久/.test(line.content)));
  const repaired = repairOffered && (!rude && !dismissed ? servedAfterRepair : true);
  const routineOnly = ownerLines > 0 && meaningful.size === 0 && !evidenceOfNeed && !waitUpdate;
  const waitUnanswered = waitPrompts > 0 && !repaired && (waitingForAnswer || !waitUpdate);
  return { ownerLines, routineOnly, evidenceOfNeed, waitUpdate, waitUnanswered, repaired, rude, dismissed, waitPrompts, leftWaiting };
}

export function serviceScore(context, fact) {
  if (!context.ownerSpoke) return fact.leftWaiting ? 2 : fact.waitPrompts ? 3 : 5;
  if (fact.rude) return fact.repaired ? 6 : 2;
  if (fact.dismissed) return fact.repaired ? 7 : 4;
  let score = fact.repaired || (fact.evidenceOfNeed && fact.waitUpdate) ? 9 :
    fact.evidenceOfNeed || fact.waitUpdate ? 8 : fact.routineOnly || !fact.ownerLines ? 6 : 7;
  if (fact.waitUnanswered)
    score -= Math.min(fact.waitPrompts, 2);
  return score;
}

export function serviceNote(context, fact) {
  if (fact.rude) return fact.repaired ? "老板前面说话挺冲，后来有认真道歉。" : "老板几句话说得挺难听，吃饭的兴致也没了。";
  if (fact.dismissed) return fact.repaired ? "问的时候有点敷衍，后来还是回应了。" : "提了个问题，老板回得有点敷衍。";
  if (fact.leftWaiting) return fact.waitUpdate ? "老板说了还有多久，不过我最后还是没等到。" :
    (fact.waitPrompts ? "问了进度也没个准话，最后我先走了。" : "等菜的时候没得到消息，最后我先走了。");
  if (fact.repaired) return "提了问题以后，老板有回应，也给出了处理办法。";
  if (fact.waitUpdate && fact.waitUnanswered) return "前面有回应，后来再问也没听到明确的进度。";
  if (fact.waitPrompts > 0) return fact.waitUpdate ? "等了一会儿，老板把进度说清楚了。" :
    (fact.waitPrompts >= 2 ? "问了两次还要等多久，一直没等到明白的答复。" : "等菜时问过进度，心里还是没底。");
  if (fact.evidenceOfNeed) return "我说了自己的要求，老板听明白了，还跟我确认了一遍。";
  if (!context.ownerSpoke) return context.servedDishes.length ? "吃饭时基本没交流。" : "";
  return fact.routineOnly ? "店主打了招呼，交流比较简单。" : "聊了几句，交流还算顺畅。";
}

export function supportsServicePraise(context, proof) {
  if (typeof proof !== "string") return false;
  const [guestQuote, ownerQuote] = proof.split(/[｜|]/).map(compact);
  if (!guestQuote || guestQuote.length < 4 || !ownerQuote || ownerQuote.length < 5 ||
      courtesy.test(guestQuote) || courtesy.test(ownerQuote)) return false;

  let lastGuest = "";
  for (const { role, content } of context.history) {
    const text = compact(content);
    if (role === "assistant") {
      lastGuest = text;
    } else if (lastGuest.includes(guestQuote) && text.includes(ownerQuote) &&
        !content.startsWith("【上菜】") && !courtesy.test(text)) {
      return true;
    }
  }
  return false;
}

export function reviewLimits(context, ratings, fact, conditions) {
  let serviceLimit = context.ownerSpoke ? 10 : 5;
  let overallLimit = 10;
  if (fact.routineOnly) serviceLimit = Math.min(serviceLimit, 7);
  if (!conditions.provedContext && !fact.evidenceOfNeed && !fact.waitUpdate && !fact.repaired)
    serviceLimit = Math.min(serviceLimit, 8);
  if (fact.rude) {
    serviceLimit = Math.min(serviceLimit, fact.repaired ? 7 : 4);
    overallLimit = Math.min(overallLimit, fact.repaired ? 8 : 5);
  } else if (fact.dismissed && !fact.repaired) {
    serviceLimit = Math.min(serviceLimit, 6);
    overallLimit = Math.min(overallLimit, 7);
  }
  if (fact.leftWaiting) {
    serviceLimit = Math.min(serviceLimit, fact.waitUpdate ? 6 : 4);
    overallLimit = Math.min(overallLimit, 5);
  } else if (fact.waitPrompts >= 2 && fact.waitUnanswered) {
    serviceLimit = Math.min(serviceLimit, 6);
    overallLimit = Math.min(overallLimit, 7);
  }
  if (conditions.overserved || conditions.missedPremium) overallLimit = Math.min(overallLimit, 7);
  if (conditions.missedPremium) ratings.food = Math.min(ratings.food, 7);
  if (conditions.allRuined) {
    overallLimit = Math.min(overallLimit, 4);
    ratings.food = Math.min(ratings.food, 2);
  } else if (conditions.anyRuined || conditions.allRough) {
    ratings.food = Math.min(ratings.food, 7);
  }
  if (!context.servedDishes.length) ratings.food = overallLimit = 0;

  ratings.service = Math.min(ratings.service, serviceLimit);
  if (ratings.food <= 7 && ratings.service <= 7) overallLimit = Math.min(overallLimit, 8);
  ratings.overall = Math.min(ratings.overall, overallLimit);
  return context.priceTone === "refused" ? Math.min(overallLimit, 6) : overallLimit;
}
