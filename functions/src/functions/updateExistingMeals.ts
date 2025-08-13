/**
 * Update existing meals with new description fields using OpenAI
 */

import {db} from "../firebase";
import {callOpenAI, textMsg} from "../utils/openai";
import {COLLECTIONS, GeneratedMeal} from "../types/firestore";
import {ALL_TAGS} from "../constants/tags";
import * as admin from "firebase-admin";

interface MealUpdateData {
  title_localized: {
    en: string;
    ru: string;
  };
  description_localized: {
    en: string;
    ru: string;
  };
  benefits: {
    en: string;
    ru: string;
  };
  improvements: {
    en: string;
    ru: string;
  };
  ingredients: {
    en: string[];
    ru: string[];
  };
  recipe: {
    en: string;
    ru: string;
  };
  healthy_alternatives: {
    en: string;
    ru: string;
  };
  meal_type: "full_meal" | "snack" | "drink";
  difficulty: "very_easy" | "easy" | "medium";
  prep_time_minutes: number;
  is_comfort_food: boolean;
  is_healthy_alternative: boolean;
}

/**
 * Clean and parse JSON response from GPT
 */
function parseGptJsonResponse(responseText: string): MealUpdateData {
  let cleanedText = responseText.trim();

  // Удаляем markdown блоки если есть
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.replace(/^```json\s*/, "");
  }
  if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/^```\s*/, "");
  }
  if (cleanedText.endsWith("```")) {
    cleanedText = cleanedText.replace(/\s*```$/, "");
  }

  // Удаляем возможные лишние символы в начале и конце
  cleanedText = cleanedText.trim();

  try {
    const parsed = JSON.parse(cleanedText) as MealUpdateData;
    return parsed;
  } catch (error) {
    console.error("❌ Ошибка парсинга JSON:", error);
    console.error("📝 Исходный текст:", responseText.substring(0, 500) + "...");
    console.error("🧹 Очищенный текст:", cleanedText.substring(0, 500) + "...");
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to parse JSON response: ${errorMessage}`);
  }
}

/**
 * Generate enhanced description for existing meal using GPT-4o
 */
async function generateEnhancedMealDescription(
  meal: GeneratedMeal
): Promise<MealUpdateData> {
  const logMessage = `🤖 Генерируем улучшенное описание для блюда: ${meal.title}`;
  console.log(logMessage);

  const availableTags = ALL_TAGS.join(", ");
  const systemPrompt = [
    "You are a professional nutrition coach following MyPlate guidelines.",
    "You have an existing meal that needs enhanced descriptions.",
    "Generate comprehensive information for this meal.",
    "",
    "Requirements:",
    "- Title: max 35 characters (both languages)",
    "- Generate realistic, detailed descriptions",
    "- Include simple snacks (like \"Apple\" or \"Banana\") when appropriate",
    "- Cooking time: 0–20 minutes maximum",
    "- IMPORTANT: Always provide detailed cooking instructions",
    "- Be creative and detailed in descriptions while staying realistic",
    "",
    `Available tags: ${availableTags}`,
    "",
    "IMPORTANT: Return ONLY valid JSON without any markdown formatting or code blocks.",
    "",
    "Return JSON with this exact structure:",
    "{",
    "  \"title_localized\": {",
    "    \"en\": \"English title (≤35 chars)\",",
    "    \"ru\": \"Русское название (≤35 символов)\"",
    "  },",
    "  \"description_localized\": {",
    "    \"en\": \"Detailed English description of the dish, its taste, texture,",
    "           aroma, and nutritional value (2-3 sentences)\",",
    "    \"ru\": \"Подробное русское описание блюда, его вкуса, текстуры, аромата",
    "           и пищевой ценности (2-3 предложения)\"",
    "  },",
    "  \"benefits\": {",
    "    \"en\": \"What's good about this food - specific health benefits, vitamins,",
    "           minerals, nutrients, and how they help the body\",",
    "    \"ru\": \"Что хорошего в этой еде - конкретная польза для здоровья,",
    "           витамины, минералы, питательные вещества и как они помогают организму\"",
    "  },",
    "  \"improvements\": {",
    "    \"en\": \"What could be improved - suggest healthier cooking methods,",
    "           portion sizes, ingredient substitutions, or timing\",",
    "    \"ru\": \"Что можно улучшить - предложите более здоровые способы приготовления,",
    "           размеры порций, замены ингредиентов или время приема\"",
    "  },",
    "  \"ingredients\": {",
    "    \"en\": [\"ingredient1\", \"ingredient2\", \"ingredient3\"],",
    "    \"ru\": [\"ингредиент1\", \"ингредиент2\", \"ингредиент3\"]",
    "  },",
    "  \"recipe\": {",
    "    \"en\": \"DETAILED step-by-step cooking instructions. Include prep time,",
    "           cooking method, temperature if needed, and serving suggestions.",
    "           For simple items like fruits, explain how to select, prepare,",
    "           and serve.\",",
    "    \"ru\": \"ПОДРОБНЫЕ пошаговые инструкции по приготовлению. Включите время",
    "           подготовки, способ приготовления, температуру если нужно, и советы",
    "           по подаче. Для простых продуктов как фрукты, объясните как выбрать,",
    "           подготовить и подать.\"",
    "  },",
    "  \"healthy_alternatives\": {",
    "    \"en\": \"Healthy ingredient swaps and substitutions to make this dish",
    "           more nutritious or lower calorie\",",
    "    \"ru\": \"Здоровые замены ингредиентов и альтернативы чтобы сделать блюдо",
    "           более питательным или менее калорийным\"",
    "  },",
    "  \"meal_type\": \"full_meal\",",
    "  \"difficulty\": \"easy\",",
    "  \"prep_time_minutes\": 15,",
    "  \"is_comfort_food\": false,",
    "  \"is_healthy_alternative\": true",
    "}",
    "",
    "Focus on realistic, achievable recipes that match the existing meal data",
    "and nutritional profile.",
    "",
    "Remember: Return ONLY the JSON object, no markdown formatting,",
    "no code blocks, no additional text.",
  ].join("\n");

  const mealInfo = `
 Existing meal:
 - Title: ${meal.title}
 - Description: ${meal.comment || "No description"}
 - Calories: ${meal.calories}
 - Proteins: ${meal.proteins}g
 - Fats: ${meal.fats}g
 - Carbs: ${meal.carbohydrates}g
 - Tags: ${meal.tags?.join(", ") || "None"}
 - Language: ${meal.language || "en"}
 `;

  const messages = [
    textMsg("developer", systemPrompt),
    textMsg("user", ["Generate enhanced description for this meal:", mealInfo].join("\n")),
  ];

  try {
    const model = "gpt-5-mini";
    const {text: responseText, usage} = await callOpenAI({
      model,
      messages,
      responseFormat: "json_object",
      reasoningEffort: "low",
      // tools: []
    });
    if (usage) {
      console.log("🧮 Tokens:", {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      });
    }

    // Используем типизированный парсер JSON
    const updateData = parseGptJsonResponse(responseText);

    // Дополнительная валидация структуры
    if (!updateData.title_localized || !updateData.description_localized || !updateData.benefits) {
      throw new Error("Invalid response structure: missing required fields");
    }

    console.log(`✅ Описание сгенерировано для ${meal.title}`);
    return updateData;
  } catch (error) {
    console.error(`❌ Ошибка генерации описания для ${meal.title}:`, error);
    throw error;
  }
}

/**
 * Update a single meal with enhanced descriptions (with retry logic)
 */
async function updateSingleMeal(
  mealId: string,
  meal: GeneratedMeal
): Promise<boolean> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Проверяем, нужно ли обновление (если уже есть новые поля)
      if (meal.description_localized && meal.benefits && meal.ingredients) {
        console.log(`⏭️ Блюдо ${meal.title} уже обновлено, пропускаем`);
        return true;
      }

      console.log(`🔄 Попытка ${attempt}/${maxRetries} обновления ${meal.title}`);

      // Генерируем новое описание
      const updateData = await generateEnhancedMealDescription(meal);

      // Обновляем документ в Firestore (НЕ трогаем фото и основные поля)
      await db.collection(COLLECTIONS.GENERATED_MEALS).doc(mealId).update({
        ...updateData,
        updated_time: admin.firestore.Timestamp.now(),
      });

      console.log(`✅ Блюдо ${meal.title} успешно обновлено на попытке ${attempt}`);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error(`❌ Ошибка обновления блюда ${meal.title} (попытка ${attempt}/${maxRetries}): ${errorMessage}`);

      // Логируем подробности для JSON ошибок
      if (errorMessage.includes("JSON") || errorMessage.includes("parse")) {
        console.error(`🔍 JSON parsing error details for ${meal.title}:`, error);
      }

      if (attempt === maxRetries) {
        console.error(`💥 Не удалось обновить ${meal.title} после ${maxRetries} попыток`);
        return false;
      }

      // Ждем перед повторной попыткой (exponential backoff)
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.log(`⏳ Ждем ${delay/1000}с перед повторной попыткой...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return false;
}

/**
 * Update existing meals in batches (optimized for long-running process)
 */
async function updateMealsInBatches(startAfter?: string): Promise<{
  processed: number;
  updated: number;
  hasMore: boolean;
  lastProcessedId?: string;
}> {
  const BATCH_SIZE = 5; // Уменьшаем размер батча для более стабильной работы с GPT-4o

  console.log(`📦 Обрабатываем батч блюд (размер: ${BATCH_SIZE})`);

  let query = db
    .collection(COLLECTIONS.GENERATED_MEALS)
    .orderBy("created_time", "asc")
    .limit(BATCH_SIZE);

  // Если есть точка продолжения, начинаем после неё
  if (startAfter) {
    const startDoc = await db.collection(COLLECTIONS.GENERATED_MEALS).doc(startAfter).get();
    if (startDoc.exists) {
      query = query.startAfter(startDoc);
    }
  }

  const mealsSnap = await query.get();

  if (mealsSnap.empty) {
    console.log("📭 Больше блюд для обработки нет");
    return {processed: 0, updated: 0, hasMore: false};
  }

  let processedCount = 0;
  let updatedCount = 0;
  let lastProcessedId = "";

  for (const doc of mealsSnap.docs) {
    const meal = doc.data() as GeneratedMeal;
    lastProcessedId = doc.id;
    processedCount++;

    try {
      const success = await updateSingleMeal(doc.id, meal);
      if (success) {
        updatedCount++;
      }
    } catch (error) {
      console.error(`❌ Ошибка обновления блюда ${meal.title} (${doc.id}):`, error);
    }
  }

  const hasMore = processedCount === BATCH_SIZE;

  console.log(`✅ Обработано блюд: ${processedCount}, Обновлено: ${updatedCount}`);

  return {
    processed: processedCount,
    updated: updatedCount,
    hasMore,
    lastProcessedId,
  };
}

/**
 * Process only one batch (for scheduled updates)
 */
export async function updateSingleBatchOnly(): Promise<{
  processed: number;
  updated: number;
  hasMore: boolean;
}> {
  console.log("📦 Обрабатываем один батч (scheduled)...");

  try {
    // Получаем точку продолжения из системного документа
    const progressDoc = await db.collection("system").doc("meal_update_progress").get();
    let startAfter: string | undefined;

    if (progressDoc.exists) {
      startAfter = progressDoc.data()?.lastProcessedId;
    }

    // Обрабатываем один батч
    const result = await updateMealsInBatches(startAfter);

    // Сохраняем прогресс
    if (result.hasMore && result.lastProcessedId) {
      await db.collection("system").doc("meal_update_progress").set({
        lastProcessedId: result.lastProcessedId,
        totalProcessed: (progressDoc.data()?.totalProcessed || 0) + result.processed,
        totalUpdated: (progressDoc.data()?.totalUpdated || 0) + result.updated,
        lastUpdate: admin.firestore.Timestamp.now(),
      });
    } else {
      // Если обработка завершена, удаляем прогресс
      await db.collection("system").doc("meal_update_progress").delete();
      console.log("🎉 Все блюда обработаны! Прогресс сброшен.");
    }

    return {
      processed: result.processed,
      updated: result.updated,
      hasMore: result.hasMore,
    };
  } catch (error) {
    console.error("❌ Ошибка обработки батча:", error);
    throw error;
  }
}

/**
 * Get update statistics
 */
export async function getUpdateStats(): Promise<{
  totalProcessed: number;
  totalUpdated: number;
  lastUpdate: string;
  hasMore: boolean;
}> {
  try {
    const progressDoc = await db.collection("system").doc("meal_update_progress").get();

    if (progressDoc.exists) {
      const data = progressDoc.data();
      if (data) {
        return {
          totalProcessed: data.totalProcessed || 0,
          totalUpdated: data.totalUpdated || 0,
          lastUpdate: data.lastUpdate?.toDate()?.toISOString() || "Never",
          hasMore: true,
        };
      }
    }

    // Добавляем return statement для случая, когда документ не существует или data пустая
    return {
      totalProcessed: 0,
      totalUpdated: 0,
      lastUpdate: "Never",
      hasMore: false,
    };
  } catch (error) {
    console.error("❌ Ошибка получения статистики:", error);
    throw error;
  }
}

/**
 * Check if update process is already running (enhanced)
 */
export async function isUpdateProcessRunning(): Promise<boolean> {
  try {
    const lockDoc = await db.collection("system").doc("meal_update_lock").get();
    if (!lockDoc.exists) return false;

    const lockData = lockDoc.data();
    const lockTime = lockData?.timestamp?.toDate();
    const now = new Date();

    // Для scheduled updates сокращаем время блокировки до 30 минут
    if (lockTime && (now.getTime() - lockTime.getTime()) > 30 * 60 * 1000) {
      console.log("🔓 Старая блокировка обнаружена (30+ мин), снимаем...");
      await releaseLock();
      return false;
    }

    return lockData?.locked === true;
  } catch (error) {
    console.error("❌ Ошибка проверки блокировки:", error);
    return false;
  }
}

/**
 * Acquire lock for update process
 */
export async function acquireLock(): Promise<boolean> {
  try {
    const lockRef = db.collection("system").doc("meal_update_lock");

    await lockRef.set({
      locked: true,
      timestamp: admin.firestore.Timestamp.now(),
      process_id: `update_${Date.now()}`,
    });

    console.log("🔒 Блокировка установлена");
    return true;
  } catch (error) {
    console.error("❌ Ошибка установки блокировки:", error);
    return false;
  }
}

/**
 * Release lock for update process
 */
export async function releaseLock(): Promise<void> {
  try {
    await db.collection("system").doc("meal_update_lock").delete();
    console.log("🔓 Блокировка снята");
  } catch (error) {
    console.error("❌ Ошибка снятия блокировки:", error);
  }
}

/**
 * Main function to update all existing meals (with locking mechanism)
 */
export async function updateAllExistingMeals(): Promise<void> {
  console.log("🔄 Запуск обновления всех существующих блюд с GPT-4o...");

  // Проверяем, не запущен ли уже процесс
  if (await isUpdateProcessRunning()) {
    const message = "⚠️ Процесс обновления блюд уже запущен! Прекращаем выполнение.";
    console.log(message);
    throw new Error("Update process already running");
  }

  // Устанавливаем блокировку
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    throw new Error("Failed to acquire lock");
  }

  try {
    let totalProcessed = 0;
    let totalUpdated = 0;
    let startAfter: string | undefined;
    let batchNumber = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      console.log(`\n🔄 Обрабатываем батч ${batchNumber}...`);
      const batchStartTime = Date.now();

      const result = await updateMealsInBatches(startAfter);

      totalProcessed += result.processed;
      totalUpdated += result.updated;
      startAfter = result.lastProcessedId;

      const batchDuration = (Date.now() - batchStartTime) / 1000;
      console.log(
        `📊 Общий прогресс: обработано ${totalProcessed}, обновлено ${totalUpdated}`
      );
      console.log(`⏱️ Батч ${batchNumber} занял ${batchDuration.toFixed(1)}с`);

      batchNumber++;

      // Если больше нет блюд для обработки
      if (!result.hasMore) {
        break;
      }

      // Увеличенная пауза между батчами для стабильности
      console.log("⏳ Пауза между батчами 5 секунд...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const message =
      `\n✅ Обновление завершено! Всего обработано: ${totalProcessed}, ` +
      `обновлено: ${totalUpdated}`;
    console.log(message);
  } catch (error) {
    console.error("❌ Ошибка в updateAllExistingMeals:", error);
    throw error;
  } finally {
    // Обязательно снимаем блокировку в любом случае
    await releaseLock();
  }
}

/**
 * Update specific number of meals (for testing)
 */
export async function updateLimitedMeals(limit = 5): Promise<void> {
  console.log(`🧪 Тестовое обновление ${limit} блюд...`);

  try {
    const mealsSnap = await db
      .collection(COLLECTIONS.GENERATED_MEALS)
      .limit(limit)
      .get();

    if (mealsSnap.empty) {
      console.log("📭 Блюд для обновления не найдено");
      return;
    }

    let updatedCount = 0;

    for (const doc of mealsSnap.docs) {
      const meal = doc.data() as GeneratedMeal;

      try {
        const success = await updateSingleMeal(doc.id, meal);
        if (success) {
          updatedCount++;
        }
      } catch (error) {
        console.error(`❌ Ошибка обновления блюда ${doc.id}:`, error);
      }
    }

    const message = "✅ Тестовое обновление завершено: " +
                   `${updatedCount}/${mealsSnap.docs.length} блюд обновлено`;
    console.log(message);
  } catch (error) {
    console.error("❌ Ошибка в updateLimitedMeals:", error);
    throw error;
  }
}
