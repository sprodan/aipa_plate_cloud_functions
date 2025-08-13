import {defineSecret} from "firebase-functions/params";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onCall, onRequest} from "firebase-functions/v2/https";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {analyzeMeal as analyzeMealFunction} from "./functions/analyzeMeal";
import {generateMealsForOneTag} from "./functions/generateMeals";
import {generateSuggestionsFunction} from "./functions/generateSuggestions";
import {generateFirstSuggestionFunction} from "./functions/generateFirstSuggestion";
import {generateAllTags, generateMissingTags} from "./functions/generateTags";
import {
  updateAllExistingMeals,
  updateLimitedMeals,
  updateSingleBatchOnly,
  getUpdateStats,
  isUpdateProcessRunning,
  acquireLock,
  releaseLock,
} from "./functions/updateExistingMeals";
import {generateSingleTestImage, generateImagesBatch} from "./functions/generateRecraftImages";
import "./firebase";

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const RECRAFT_API_TOKEN = defineSecret("RECRAFT_API_TOKEN");

/**
 * Cloud Function to analyze a meal when a new document is created.
 */
export const analyzeMeal = onDocumentCreated(
  {
    document: "meals/{mealId}",
    secrets: [OPENAI_API_KEY], // ✅ разрешаем использовать секрет
  },
  async (event): Promise<void> => {
    const mealId: string = event.params.mealId;
    const mealData: Record<string, unknown> | undefined =
      event.data?.data();
    if (!mealData) return;

    await analyzeMealFunction(mealId, mealData);
  }
);

export const generateMealsJob = onSchedule(
  {
    schedule: "every 10 minutes",
    secrets: [OPENAI_API_KEY],
  },
  async () => {
    console.log("🚀 Автозапуск генерации начат");

    // ✅ Временная проверка: ключ подтянулся?
    const apiKeyStatus = process.env.OPENAI_API_KEY ?
      `Key loaded: ${process.env.OPENAI_API_KEY.slice(0, 7)}...` :
      "❌ Key is missing!";
    console.log(`🔑 OpenAI API Key status: ${apiKeyStatus}`);

    await generateMealsForOneTag();
  }
);

/**
 * Cloud Function to generate personalized nutrition suggestions every hour
 */
export const generateSuggestions = onSchedule(
  {
    schedule: "every 1 hours",
    secrets: [OPENAI_API_KEY],
  },
  async () => {
    console.log("🚀 Автозапуск генерации рекомендаций начат");
    await generateSuggestionsFunction();
  }
);

// ✅ Новый запуск по GET-запросу (для дебага)
export const generateSuggestionsManual = onRequest(
  {secrets: [OPENAI_API_KEY]},
  async (_req, res) => {
    console.log("🛠 Ручной запуск генерации рекомендаций начат");
    await generateSuggestionsFunction();
    res.status(200).send("✅ Ручной запуск завершён");
  }
);

/**
 * Callable Function: generate first suggestion for new users
 */
export const generateFirstSuggestion = onCall(
  {secrets: [OPENAI_API_KEY]},
  async (request) => {
    const {
      userId,
      active_calories,
      passive_calories,
      locale,
    }: {
      userId: string;
      active_calories: number;
      passive_calories: number;
      locale: "en" | "ru";
    } = request.data;

    if (
      typeof userId !== "string" ||
      typeof active_calories !== "number" ||
      typeof passive_calories !== "number" ||
      !["en", "ru"].includes(locale)
    ) {
      throw new Error("Invalid input data");
    }

    const suggestion = await generateFirstSuggestionFunction(
      userId,
      active_calories,
      passive_calories,
      locale
    );

    return {suggestion};
  }
);

/**
 * Callable Function: generate all tags with translations and colors
 */
export const generateTagsWithMetadata = onCall(
  {secrets: [OPENAI_API_KEY]},
  async () => {
    await generateAllTags();
    return {success: true, message: "All tags generated successfully"};
  }
);

/**
 * Callable Function: generate only missing tags
 */
export const generateMissingTagsOnly = onCall(
  {secrets: [OPENAI_API_KEY]},
  async () => {
    await generateMissingTags();
    return {success: true, message: "Missing tags generated successfully"};
  }
);

/**
 * HTTP endpoint for REgenerating ALL tags with new colors (for testing)
 */
export const generateTagsWithMetadataHttp = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 540, // 9 минут (максимум для HTTP функций)
    memory: "1GiB", // Больше памяти для обработки
  },
  async (_req, res) => {
    try {
      console.log("🎨 Ручной запуск регенерации ВСЕХ тегов с новыми цветами начат");

      // Отправляем немедленный ответ что процесс начался
      res.status(202).json({
        success: true,
        message: "Tag regeneration started. Check logs for progress.",
        status: "processing",
      });

      // Асинхронно запускаем генерацию ВСЕХ тегов (включая существующие)
      generateAllTags().then(() => {
        console.log("✅ Регенерация всех тегов завершена успешно!");
      }).catch((error) => {
        console.error("❌ Ошибка регенерации тегов:", error);
      });
    } catch (error) {
      console.error("❌ Ошибка запуска регенерации тегов:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * HTTP endpoint for generating missing tags only (for testing)
 */
export const generateMissingTagsOnlyHttp = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 540, // 9 минут
    memory: "1GiB",
  },
  async (_req, res) => {
    try {
      console.log("🛠 Ручной запуск генерации отсутствующих тегов начат");
      await generateMissingTags();
      res.status(200).json({
        success: true,
        message: "Missing tags generated successfully",
      });
    } catch (error) {
      console.error("❌ Ошибка генерации отсутствующих тегов:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * HTTP endpoint for generating meals (for testing)
 */
export const generateMealsManual = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 540, // 9 минут
    memory: "1GiB",
  },
  async (_req, res) => {
    try {
      console.log("🛠 Ручной запуск генерации блюд начат");
      await generateMealsForOneTag();
      res.status(200).json({
        success: true,
        message: "Meals generation completed",
      });
    } catch (error) {
      console.error("❌ Ошибка генерации блюд:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * HTTP endpoint for updating all existing meals with new descriptions
 */
export const updateExistingMealsHttp = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 540, // 9 минут
    memory: "2GiB", // Увеличиваем память для GPT-4o
  },
  async (_req, res) => {
    try {
      const message = "🔄 Ручной запуск обновления всех существующих блюд " +
                      "с GPT-4o начат";
      console.log(message);

      // Отправляем немедленный ответ что процесс начался
      res.status(202).json({
        success: true,
        message: "Meals update with GPT-4o started. This will take a long time. " +
                 "Check logs for progress.",
        status: "processing",
        estimatedDuration: "Several hours depending on number of meals",
      });

      // Асинхронно запускаем обновление
      updateAllExistingMeals().then(() => {
        console.log("✅ Обновление всех блюд с GPT-4o завершено успешно!");
      }).catch((error: Error) => {
        console.error("❌ Ошибка обновления блюд:", error);
      });
    } catch (error) {
      console.error("❌ Ошибка запуска обновления блюд:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * HTTP endpoint for updating limited number of meals (for testing)
 */
export const updateLimitedMealsHttp = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 5;
      console.log(`🧪 Тестовое обновление ${limit} блюд начато`);

      await updateLimitedMeals(limit);

      res.status(200).json({
        success: true,
        message: `${limit} meals updated successfully`,
      });
    } catch (error) {
      console.error("❌ Ошибка тестового обновления блюд:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * Scheduled function to update meals every 5 minutes (one batch at a time)
 */
export const scheduledMealsUpdate = onSchedule(
  {
    schedule: "*/5 * * * *", // Каждые 5 минут
    timeZone: "Europe/Moscow", // Московское время
    secrets: [OPENAI_API_KEY],
    memory: "2GiB",
    timeoutSeconds: 300, // 5 минут таймаут
  },
  async (_event) => { // Добавляем underscore чтобы показать что параметр не используется
    console.log("🕐 Запуск регулярного обновления блюд...");

    void _event;

    try {
      // Проверяем, есть ли блокировка от другого процесса
      if (await isUpdateProcessRunning()) {
        console.log("⏸️ Другой процесс обновления уже запущен, пропускаем...");
        return;
      }

      // Обрабатываем один батч
      const result = await updateSingleBatchOnly();

      if (result.processed === 0) {
        console.log("✅ Все блюда обновлены! Регулярное обновление завершено.");
      } else {
        const message = `✅ Регулярное обновление: обработано ${result.processed}, ` +
          `обновлено ${result.updated}`;
        console.log(message);
      }
    } catch (error) {
      console.error("❌ Ошибка регулярного обновления:", error);
    }
  }
);

/**
 * Manual trigger to start/stop scheduled updates
 */
export const toggleScheduledUpdates = onRequest(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 60,
  },
  async (req, res) => {
    const action = req.query.action as string;

    try {
      if (action === "status") {
        // Проверяем статус
        const isRunning = await isUpdateProcessRunning();
        const stats = await getUpdateStats();

        res.json({
          success: true,
          isRunning,
          stats,
          message: `Scheduled updates ${isRunning ? "активны" : "неактивны"}`,
        });
      } else if (action === "stop") {
        // Останавливаем (устанавливаем блокировку)
        await acquireLock();
        res.json({
          success: true,
          message: "Scheduled updates остановлены",
        });
      } else if (action === "start") {
        // Запускаем (снимаем блокировку)
        await releaseLock();
        res.json({
          success: true,
          message: "Scheduled updates запущены",
        });
      } else {
        res.status(400).json({
          success: false,
          error: "Используйте ?action=status|start|stop",
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * Test function: generate one Recraft image
 */
export const testRecraftImageGeneration = onRequest(
  {
    secrets: [RECRAFT_API_TOKEN],
    timeoutSeconds: 300, // 5 минут
    memory: "1GiB",
  },
  async (_req, res) => {
    try {
      console.log("🧪 Запуск тестовой генерации Recraft изображения...");

      await generateSingleTestImage();

      res.status(200).json({
        success: true,
        message: "Test image generated successfully! Check logs for URL.",
      });
    } catch (error) {
      console.error("❌ Ошибка тестовой генерации:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * Scheduled function: generate meal images every 5 minutes (10 at a time)
 */
export const scheduledRecraftImageGeneration = onSchedule(
  {
    schedule: "*/5 * * * *", // Каждые 5 минут
    timeZone: "Europe/Moscow",
    secrets: [RECRAFT_API_TOKEN],
    memory: "2GiB",
    timeoutSeconds: 300, // 5 минут
  },
  async (_event) => { // Добавляем underscore
    console.log("🕐 Запуск регулярной генерации Recraft изображений...");

    void _event;

    try {
      const result = await generateImagesBatch();

      if (result.processed === 0) {
        console.log("✅ Все изображения сгенерированы! Регулярная генерация завершена.");
      } else {
        const message = `✅ Регулярная генерация: обработано ${result.processed}, ` +
          `сгенерировано ${result.generated}, ошибок ${result.failed}`;
        console.log(message);
      }
    } catch (error) {
      console.error("❌ Ошибка регулярной генерации изображений:", error);
    }
  }
);
