/**
 * This file contains the main scheduled function that generates personalized nutrition suggestions
 * for users based on their meals and sends push notifications.
 */

import {db} from "../firebase";
import {callOpenAI, textMsg} from "../utils/openai";
// типы из chat/completions больше не нужны
import {DocumentReference, DocumentData} from "firebase-admin/firestore";
import * as admin from "firebase-admin";
import {recommendMeals} from "./recommendMeals";
import {Meal, User, GeneratedMeal, COLLECTIONS} from "../types/firestore";

// Локальный интерфейс для работы с блюдами в памяти (с Date вместо Timestamp)
interface MealData {
  title: string;
  tags: string[];
  proteins: number;
  fats: number;
  carbohydrates: number;
  calories: number;
  created_time: Date;
  meal_type?: "breakfast" | "lunch" | "dinner" | "snack";
}

// ДОБАВЛЕНО: тип для списка предложенных блюд, который передаём в GPT
interface GeneratedMealGPT {
  title: string;
  calories?: number;
  tags?: string[];
  photo?: string;
}

const SHORT_LIMIT = 100; // пуш
const LONG_LIMIT = 400; // длинная рекомендация - увеличено для более детального объяснения

const MAX_RETRIES = 3;

/**
 * Get local hour based on user's hoursOffset or fallback to created_time timezone.
 */
function getLocalHour(user: User): number {
  const utcNow = new Date();

  // Используем hoursOffset если доступен
  if (typeof user.hoursOffset === "number") {
    const localNow = new Date(utcNow.getTime() + user.hoursOffset * 60 * 60 * 1000);
    return localNow.getHours();
  }

  // Fallback к старому методу через created_time
  const offsetMinutes = -user.created_time.toDate().getTimezoneOffset();
  const localNow = new Date(utcNow.getTime() + offsetMinutes * 60 * 1000);
  return localNow.getHours();
}

/**
 * Map hour to time of day string.
 */
function getTimeOfDay(hour: number): "morning" | "lunch" | "dinner" {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "lunch";
  return "dinner";
}

/**
 * Calculate daily macronutrient norm based on user settings.
 */
function calculateDailyNorm(active: number, passive: number) {
  const totalCalories = active + passive;
  return {
    calories: totalCalories,
    proteins: Math.round((totalCalories * 0.25) / 4),
    fats: Math.round((totalCalories * 0.25) / 9),
    carbohydrates: Math.round((totalCalories * 0.5) / 4),
  };
}

/**
 * Get today's meals for user.
 */
async function getMealsData(
  mealRefs: DocumentReference<DocumentData>[],
): Promise<MealData[]> {
  if (!Array.isArray(mealRefs) || mealRefs.length === 0) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const meals: MealData[] = [];
  for (const ref of mealRefs) {
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() as Meal;
    const created = data.created_time?.toDate() as Date;
    if (created && created >= today) {
      meals.push({
        title: data.title ?? "",
        tags: data.tags ?? [],
        proteins: data.proteins ?? 0,
        fats: data.fats ?? 0,
        carbohydrates: data.carbohydrates ?? 0,
        calories: data.calories ?? 0,
        created_time: created,
        meal_type:
          (data as Partial<Meal> & {
            meal_type?: "breakfast" | "lunch" | "dinner" | "snack";
          }).meal_type, // ДОБАВЛЕНО: прокидываем meal_type из БД
      });
    }
  }
  return meals;
}

/**
 * Sum up macro values from a list of meals.
 */
function summarizeMeals(meals: MealData[]) {
  return meals.reduce(
    (acc, m) => {
      acc.proteins += m.proteins;
      acc.fats += m.fats;
      acc.carbohydrates += m.carbohydrates;
      acc.calories += m.calories;
      return acc;
    },
    {proteins: 0, fats: 0, carbohydrates: 0, calories: 0},
  );
}

/**
 * Get user's top liked tags.
 */
async function getTopLikedTags(
  userRef: DocumentReference<DocumentData>,
): Promise<string[]> {
  const snap = await db
    .collection(COLLECTIONS.USER_TAG_STATISTICS)
    .where("user_ref", "==", userRef)
    .orderBy("count", "desc")
    .limit(3)
    .get();
  return snap.docs.map((d) => d.data().tag_ref as string);
}

/**
 * Вспомогательно: аккуратно ужимаем текст под лимит символов
 */
function clampText(text: string, max: number): string {
  if (!text) return "";
  // убираем двойные пробелы/переводы строк
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).trim();
}

/**
 * Generate GPT-based suggestion in short and long localized form.
 */
async function generateLocalizedSuggestions(
  data: Record<string, unknown>,
  locale: "en" | "ru",
  isFirstTime = false,
): Promise<{short: string; long: string}> {
  const firstTimePrompt = isFirstTime ?
    (locale === "ru" ?
      "\n\nВНИМАНИЕ: это НОВЫЙ пользователь, пока не вносил блюда. Подбодри, предложи простой старт для" +
      "текущего времени суток." :
      "\n\nNOTE: NEW user with no meals logged yet. Encourage a simple start for the current time_of_day.") :
    "";

  const styleInstruction =
    locale === "ru" ?
      "Пиши нативным разговорным русским, на ты, как нутрициолог в чате. Коротко, дружелюбно, без канцелярита." :
      [
        "Write in natural conversational US English, casual and friendly,",
        "like a nutritionist texting. Keep it short and personal.",
      ].join(" ");

  const instruction =
    locale === "ru" ?
      [
        "Анализируй eaten_today и определи баланс рациона: что съедено много, что мало.",
        "НЕ ИСПОЛЬЗУЙ ЦИФРЫ И ГРАММЫ! Говори качественно: 'много', 'мало', 'достаточно'.",
        "Примеры ХОРОШЕГО анализа:",
        "✅ 'Ты сегодня съел много жиров, давай компенсируем это углеводами и клетчаткой'",
        "✅ 'Маловато белка сегодня, добавим что-то сытное'",
        "✅ 'Отлично сбалансировал! Теперь можешь позволить лёгкий перекус'",
        "❌ НЕ ГОВОРИ: 'Не хватает 139г белка, 56г жиров, 1674 ккал'",
        "",
        "ВАЖНО: если последний приём — ужин, не предлагай новый ужин!",
        "Вместо этого предложи лёгкий перекус (орехи, йогурт, фрукты).",
        "Для завтрака/обеда можно полноценную еду.",
        "",
        "ФОКУС НА ПОЛЬЗЕ ПРЯМО СЕЙЧАС:",
        "- Утром: 'зарядит энергией', 'поможет сконцентрироваться'",
        "- Днём: 'не будешь засыпать после обеда', 'хватит сил до вечера'",
        "- Вечером: 'поможет лучше спать', 'завтра будешь бодрее', 'меньше отёков'",
        "",
        "Названия продуктов ТОЛЬКО на русском.",
        "Следуй MyPlate: больше овощей, цельнозерновых, нежирного белка.",
        "Если в рационе много вредного — мягко предложи замену.",
        "",
        `1) short — максимум ${SHORT_LIMIT} символов, цепляющий заголовок без цифр`,
        "2) long — максимум 400 символов, объясни ПОЧЕМУ это поможет именно сейчас",
        "Тон: как заботливый друг-нутрициолог. Без эмодзи, без 'привет'.",
        "Верни JSON {\"short\": string, \"long\": string}.",
      ].join(" ") :
      [
        "Analyze eaten_today and determine diet balance: what's high, what's low.",
        "NO NUMBERS OR GRAMS! Speak qualitatively: 'high', 'low', 'adequate'.",
        "Examples of GOOD analysis:",
        "✅ 'You've had lots of fats today, let's balance with carbs and fiber'",
        "✅ 'Light on protein today, let's add something filling'",
        "✅ 'Great balance! Now you can have a light snack'",
        "❌ DON'T SAY: 'Missing 139g protein, 56g fats, 1674 calories'",
        "",
        "IMPORTANT: if last meal was dinner, don't suggest another dinner!",
        "Instead offer light snacks (nuts, yogurt, fruit).",
        "For breakfast/lunch, full meals are fine.",
        "",
        "FOCUS ON IMMEDIATE BENEFITS:",
        "- Morning: 'energize your day', 'boost focus'",
        "- Afternoon: 'avoid afternoon crash', 'sustain energy'",
        "- Evening: 'sleep better tonight', 'feel fresh tomorrow', 'reduce bloating'",
        "",
        "Food names ONLY in English.",
        "Follow MyPlate: more vegetables, whole grains, lean protein.",
        "If diet has unhealthy items — gently suggest swaps.",
        "",
        `1) short — max ${SHORT_LIMIT} chars, catchy headline without numbers`,
        "2) long — max 400 chars, explain WHY this helps right now",
        "Tone: caring nutritionist friend. No emojis, no 'hello'.",
        "Return JSON {\"short\": string, \"long\": string}.",
      ].join(" ");

  const messages = [
    textMsg(
      "developer",
      (locale === "ru" ?
        "Ты персональный нутрициолог. Анализируешь рацион по принципам MyPlate и даёшь " +
        "практические советы. " :
        "You are a personal nutritionist. Analyze diet by MyPlate principles and give " +
        "practical advice. ") + styleInstruction
    ),
    textMsg(
      "user",
      JSON.stringify(data) + "\n\n" + instruction + firstTimePrompt
    ),
  ];

  const model = "gpt-5-mini"; // Экономически обоснованный выбор для массовых рекомендаций

  // Заменяем прямой вызов Responses API на универсальный
  const {text: content, usage} = await callOpenAI({
    model,
    messages,
    responseFormat: "json_object",
    reasoningEffort: "low",
    // tools при необходимости можно прокинуть:
    // tools: []
  });
  if (usage) {
    console.log("🧮 Tokens:", {
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      total: usage.total_tokens,
    });
  }

  let shortTxt = "";
  let longTxt = "";
  try {
    const parsed = JSON.parse(content) as { short?: string; long?: string };
    shortTxt = parsed.short ?? "";
    longTxt = parsed.long ?? "";
  } catch {
    shortTxt = content.slice(0, SHORT_LIMIT);
    longTxt = content.slice(0, LONG_LIMIT);
  }

  shortTxt = clampText(shortTxt, SHORT_LIMIT);
  longTxt = clampText(longTxt, LONG_LIMIT);
  return {short: shortTxt, long: longTxt};
}

/**
 * Get user email for logging purposes
 */
async function getUserEmail(userId: string): Promise<string> {
  try {
    const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data() as User;
      return userData.email || userId;
    }
    return userId;
  } catch {
    return userId;
  }
}

/**
 * Truncate text for logging
 */
function truncateText(text: string, maxLength = 100): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

/**
 * Generate suggestion for a specific user by userId
 */
export async function generateSuggestionForUser(
  userId: string,
  isFirstTime = false
): Promise<void> {
  const userEmail = await getUserEmail(userId);
  console.log(
    `🚀 Генерация ${isFirstTime ? "первой " : ""}рекомендации для пользователя ${userEmail}`
  );

  const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
  if (!userDoc.exists) {
    console.log(`⚠️ Пользователь ${userEmail} не найден`);
    return;
  }

  const user = userDoc.data() as User;

  if (
    typeof user.active_calories !== "number" ||
    typeof user.passive_calories !== "number" ||
    isNaN(user.active_calories) ||
    isNaN(user.passive_calories)
  ) {
    console.log(`⚠️ Пропускаем ${userEmail}: нет корректных калорий`);
    return;
  }

  const hour = getLocalHour(user);
  const timeOfDay = getTimeOfDay(hour);

  // Логируем источник времени для отладки
  const timeSource = typeof user.hoursOffset === "number" ?
    `hoursOffset=${user.hoursOffset}` :
    "created_time fallback";
  console.log(
    `🕐 ${userEmail}: локальный час=${hour} (${timeSource}), время дня=${timeOfDay}`
  );

  // Для первой рекомендации используем пустой массив блюд
  const meals = isFirstTime ? [] : await getMealsData(user.meals ?? []);
  const totalToday = summarizeMeals(meals);
  const dailyNorm = calculateDailyNorm(
    user.active_calories,
    user.passive_calories,
  );
  const remaining = Math.max(dailyNorm.calories - totalToday.calories, 0);

  // Для первой рекомендации нет предпочтений по тегам
  const likedTags = isFirstTime ? [] : await getTopLikedTags(userDoc.ref);

  console.log(
    `📊 ${userEmail}: время=${timeOfDay}, съедено=${totalToday.calories}кал, ` +
    `норма=${dailyNorm.calories}кал, осталось=${remaining}кал`
  );

  const suggestedMealsRefs = await recommendMeals({
    userRef: userDoc.ref,
    timeOfDay,
    dailyNorm,
    totalToday,
    likedTags,
  });

  if (suggestedMealsRefs.length) {
    await db.collection(COLLECTIONS.USERS).doc(user.uid).update({
      suggested_generated_meals: suggestedMealsRefs,
    });
    console.log(`🍽️ ${userEmail}: предложено ${suggestedMealsRefs.length} блюд`);
  }

  let suggestedMealsList: GeneratedMealGPT[] = [];
  if (suggestedMealsRefs.length) {
    suggestedMealsList = await Promise.all(
      suggestedMealsRefs.map(async (ref) => {
        const snap = await ref.get();
        const d = snap.data() as GeneratedMeal;
        return {
          title: d.title,
          calories: d.calories,
          tags: d.tags,
          photo: d.photo,
        };
      }),
    );
  }

  const dataForGPT = {
    time_of_day: timeOfDay,
    eaten_today: meals,
    total_today: totalToday,
    daily_norm: dailyNorm,
    remaining,
    liked_tags: likedTags,
    suggested_meals_list: suggestedMealsList,
  };

  const locale: "en" | "ru" = user.language === "ru" ? "ru" : "en";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `🤖 ${userEmail}: GPT запрос (попытка ${attempt}/${MAX_RETRIES})`
      );

      const {short, long} = await generateLocalizedSuggestions(
        dataForGPT,
        locale,
        isFirstTime,
      );

      if (short && long) {
        console.log(`✅ ${userEmail}: рекомендация сгенерирована`);
        console.log(
          `📱 Короткая (${short.length} символов): "${truncateText(short)}"`
        );
        console.log(
          `📄 Длинная (${long.length} символов): "${truncateText(long)}"`
        );

        await saveSuggestionAndPush(
          userId,
          short,
          long,
          suggestedMealsList[0]?.photo,
        );
        break;
      } else {
        console.log(
          `⚠️ ${userEmail}: GPT вернул пустую рекомендацию (попытка ${attempt})`
        );
      }
    } catch (err) {
      console.error(
        `❌ ${userEmail}: ошибка GPT (попытка ${attempt}):`,
        err
      );
    }
  }
}

/**
 * Get all valid FCM tokens for a user.
 */
async function getUserFcmTokens(userId: string): Promise<string[]> {
  const userEmail = await getUserEmail(userId);
  console.log(`🔍 Ищем FCM токены для пользователя: ${userEmail}`);

  const tokensSnap = await db
    .collection(COLLECTIONS.USERS)
    .doc(userId)
    .collection(COLLECTIONS.FCM_TOKENS)
    .get();

  console.log(`📱 ${userEmail}: найдено документов токенов: ${tokensSnap.size}`);

  if (tokensSnap.empty) {
    console.log(`⚠️ ${userEmail}: токены не найдены`);
    return [];
  }

  const tokens = tokensSnap.docs
    .map((doc) => {
      const data = doc.data() as {fcm_token?: string};
      return data.fcm_token;
    })
    .filter((t): t is string => {
      const isValid = !!t && t.length > 20;
      return isValid;
    });

  console.log(`📲 ${userEmail}: итого валидных токенов: ${tokens.length}`);
  return tokens;
}

/**
 * Save suggestion to Firestore and send via push.
 */
async function saveSuggestionAndPush(
  userId: string,
  short: string,
  long: string,
  photoUrl?: string,
): Promise<void> {
  const userEmail = await getUserEmail(userId);
  console.log(`💾 ${userEmail}: сохраняем рекомендацию`);

  await db.collection(COLLECTIONS.USERS).doc(userId).update({suggestion: long});

  const tokens = await getUserFcmTokens(userId);

  if (!tokens.length) {
    console.log(`❌ ${userEmail}: нет валидных токенов для отправки пуша`);
    return;
  }

  console.log(`📤 ${userEmail}: отправляем пуш на ${tokens.length} устройств`);

  for (const token of tokens) {
    try {
      const message = {
        token,
        notification: {
          title: "Your nutrition tip",
          body: short,
          ...(photoUrl ? {image: photoUrl} : {}),
        },
      };

      const response = await admin.messaging().send(message);
      console.log(`📩 ${userEmail}: пуш успешно отправлен, ID: ${response}`);
    } catch (err) {
      console.error(`❌ ${userEmail}: ошибка отправки пуша:`, err);
    }
  }
}

/**
 * Main scheduled function to generate and deliver suggestions.
 */
export async function generateSuggestionsFunction(): Promise<void> {
  console.log("🚀 Запуск генерации рекомендаций");
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const usersSnap = await db.collection(COLLECTIONS.USERS).get();
  console.log(`👥 Найдено пользователей: ${usersSnap.size}`);

  for (const doc of usersSnap.docs) {
    const user = doc.data() as User;
    const userEmail = user.email || user.uid;

    if (
      typeof user.active_calories !== "number" ||
      typeof user.passive_calories !== "number" ||
      isNaN(user.active_calories) ||
      isNaN(user.passive_calories)
    ) {
      console.log(`⚠️ Пропускаем ${userEmail}: нет корректных калорий`);
      continue;
    }

    const hour = getLocalHour(user);
    const meals = await getMealsData(user.meals ?? []);
    const loggedLastHour = meals.some((m) => m.created_time >= oneHourAgo);
    const shouldSend = [8, 13, 18].includes(hour) || loggedLastHour;

    if (!shouldSend) {
      console.log(
        `⏰ ${userEmail}: не время для рекомендации ` +
        `(час=${hour}, блюд за час=${loggedLastHour})`
      );
      continue;
    }

    console.log(
      `🎯 ${userEmail}: генерируем рекомендацию ` +
      `(час=${hour}, блюд за час=${loggedLastHour})`
    );
    await generateSuggestionForUser(user.uid);
  }
  console.log("✅ Генерация рекомендаций завершена");
}
