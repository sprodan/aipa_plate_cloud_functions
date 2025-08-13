import axios, {isAxiosError} from "axios";
import {compressAndUploadImage} from "./imageUtils";

interface RecraftGenerateOptions {
  englishTitle: string;
  englishDescription: string;
  mealType: "full_meal" | "snack" | "drink";
  tags: string[];
}

/**
 * Generate food image using Recraft API (fixed according to docs)
 */
export async function generateRecraftFoodImage(options: RecraftGenerateOptions): Promise<{
  photoUrl: string;
  blurhash: string;
}> {
  const {englishTitle, englishDescription, mealType, tags} = options;

  console.log(`🎨 Генерируем Recraft изображение для: ${englishTitle}`);

  try {
    // Создаем интеллектуальный промпт
    const prompt = createSmartFoodPrompt(englishTitle, englishDescription, mealType, tags);

    console.log(`📝 Промпт: ${prompt.substring(0, 150)}...`);

    // Вызываем Recraft API - ИСПРАВЛЕННЫЙ согласно документации
    const response = await axios.post(
      "https://external.api.recraft.ai/v1/images/generations",
      {
        prompt: prompt,
        style: "realistic_image", // Согласно документации
        model: "recraftv3", // ИСПРАВЛЕНО: recraftv3 вместо recraft-v3
        size: "1024x1024", // Стандартный размер
        n: 1, // Количество изображений
        response_format: "url", // Формат ответа
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.RECRAFT_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 120000, // 2 минуты таймаут
      }
    );

    console.log("🔍 Ответ Recraft API:", JSON.stringify(response.data, null, 2));

    // Проверяем структуру ответа
    if (!response.data) {
      throw new Error("Recraft API вернул пустой ответ");
    }

    // Согласно документации, URL может быть в разных местах
    let imageUrl: string;

    if (response.data.data && response.data.data[0] && response.data.data[0].url) {
      imageUrl = response.data.data[0].url;
    } else if (typeof response.data === "string" && response.data.startsWith("https://")) {
      // Иногда API возвращает URL напрямую
      imageUrl = response.data;
    } else {
      console.error("Неожиданная структура ответа:", response.data);
      throw new Error("Не удалось извлечь URL изображения из ответа API");
    }

    console.log(`✅ Recraft изображение сгенерировано для ${englishTitle}`);
    console.log(`🔗 Raw URL: ${imageUrl}`);

    // Создаем временный ID для имени файла
    const tempMealId = englishTitle
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .substring(0, 20) + "_" + Date.now();

    // Используем существующую утилиту для сжатия и загрузки с blurhash
    console.log(`📦 Сжимаем изображение и генерируем blurhash для ${englishTitle}...`);
    const result = await compressAndUploadImage(imageUrl, undefined, tempMealId);

    console.log("✅ Изображение обработано и загружено с blurhash");
    console.log(`🔗 Final URL: ${result.photoUrl}`);
    console.log(`🎨 Blurhash: ${result.blurhash}`);

    return result;
  } catch (error) {
    console.error(`❌ Ошибка Recraft генерации для ${englishTitle}:`, error);

    if (isAxiosError(error)) {
      console.error(`HTTP Status: ${error.response?.status}`);
      console.error("Response data:", error.response?.data);
      console.error("Request URL:", error.config?.url);
    }

    throw error;
  }
}

/**
 * Create intelligent food photography prompt (optimized for Recraft)
 */
function createSmartFoodPrompt(
  title: string,
  description: string,
  mealType: string,
  tags: string[]
): string {
  // Базовый промпт - оптимизирован для Recraft
  let prompt = `Professional food photography of ${title}. `;

  // Добавляем описание (максимум 1000 символов согласно документации)
  if (description && description.length < 200) {
    prompt += `${description}. `;
  }

  // Выбираем композицию
  const compositionStyle = getCompositionStyle(title, mealType, tags);
  prompt += compositionStyle;

  // Стиль для реалистичных фото еды
  prompt += "Professional food styling, warm natural lighting, appetizing presentation. ";
  prompt += "High-end restaurant quality, commercial food photography. ";
  prompt += "Sharp focus, rich colors, inviting atmosphere.";

  // Ограничиваем длину промпта (максимум 1000 символов)
  if (prompt.length > 1000) {
    prompt = prompt.substring(0, 997) + "...";
  }

  return prompt;
}

/**
 * Get composition style optimized for Recraft realistic_image style
 */
function getCompositionStyle(title: string, mealType: string, tags: string[]): string {
  const titleLower = title.toLowerCase();

  // Супы и салаты - вид сверху
  if (titleLower.includes("soup") || titleLower.includes("salad") || titleLower.includes("bowl")) {
    return "Top-down view, elegant white ceramic bowl on marble surface. ";
  }

  // Бургеры и сэндвичи - под углом
  if (titleLower.includes("burger") || titleLower.includes("sandwich") || titleLower.includes("toast")) {
    return "45-degree angle, rustic wooden cutting board, layered presentation. ";
  }

  // Напитки - вид сбоку
  const drinkKeywords = ["drink", "juice", "smoothie", "coffee", "tea"];
  if (drinkKeywords.some((keyword) => titleLower.includes(keyword)) || mealType === "drink") {
    return "Side view, clear glass, natural ingredients visible. ";
  }

  // Десерты - элегантная подача
  const dessertKeywords = ["cake", "pie", "dessert", "ice cream", "pastry"];
  if (dessertKeywords.some((keyword) => titleLower.includes(keyword))) {
    return "Elegant plating, white porcelain plate, refined presentation. ";
  }

  // Здоровые блюда - минимализм
  const healthyTags = ["healthy", "organic", "fresh", "natural", "vegan", "vegetarian"];
  if (tags.some((tag) => healthyTags.includes(tag.toLowerCase()))) {
    return "Clean minimal composition, marble surface, fresh herbs accent. ";
  }

  // По умолчанию - классическая подача
  return "Classic food photography angle, clean white plate, professional styling. ";
}

/**
 * Mark meal as failed image generation (for retry later)
 */
export async function markMealImageFailed(mealId: string, error: string): Promise<void> {
  // ИСПРАВЛЯЕМ: добавляем .js расширение для TypeScript ES modules
  const {db} = await import("../firebase.js");

  try {
    await db.collection("generated_meals").doc(mealId).update({
      image_generation_failed: true,
      image_generation_error: error,
      image_generation_failed_at: new Date(),
      updated_time: new Date(),
    });

    console.log(`🏷️ Блюдо ${mealId} помечено как неудачная генерация изображения`);
  } catch (updateError) {
    console.error(`❌ Ошибка маркировки блюда ${mealId}:`, updateError);
  }
}
