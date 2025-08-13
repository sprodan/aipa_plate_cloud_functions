/**
 * This file generates meal suggestions using OpenAI and saves them to Firestore.
 */

import {db, bucket} from "../firebase";
import {callOpenAI, callOpenAIImage, OpenAIMessage} from "../utils/openai";
import {compressAndUploadImage} from "../utils/imageUtils";
import {GeneratedMeal, COLLECTIONS} from "../types/firestore";
import {ALL_TAGS} from "../constants/tags"; // Импортируем из constants
import * as admin from "firebase-admin";

/**
 * Generate meals for a specific tag using OpenAI.
 */
async function generateMealsForTag(tagName: string): Promise<GeneratedMeal[]> {
  console.log(`🤖 Генерируем блюда для тега: ${tagName}`);

  const systemPrompt = `You are a professional nutrition coach following MyPlate guidelines.

Generate exactly 3 diverse meals that prominently feature the tag "${tagName}".

Requirements:
- Title: max 35 characters (both languages)
- Calories: vary between ~50 (snack), ~150 (light meal), ~350 (full meal)
- Realistic American dishes, including comfort foods and healthy alternatives
- Include simple snacks (like "Apple" or "Banana") when appropriate
- Cooking time: 0-20 minutes maximum
- Mix of meal types: full meals, snacks, drinks
- IMPORTANT: Always provide detailed cooking instructions

Available tags: ${ALL_TAGS.join(", ")}

Return JSON array with this exact structure:
[
  {
    "title": "English title (≤35 chars)",
    "comment": "Brief English description",
    "calories": number,
    "proteins": number,
    "fats": number,
    "carbohydrates": number,
    "tags": ["tag1", "tag2"],
    "title_localized": {
      "en": "English title (≤35 chars)",
      "ru": "Русское название (≤35 символов)"
    },
    "description_localized": {
      "en": "Detailed English description of the dish, its taste, and nutritional value",
      "ru": "Подробное русское описание блюда, его вкуса и пищевой ценности"
    },
    "benefits": {
      "en": "What's good about this food - specific health benefits, vitamins, minerals",
      "ru": "Что хорошего в этой еде - конкретная польза для здоровья, витамины, минералы"
    },
    "improvements": {
      "en": "What could be improved - healthier cooking methods, portions, substitutions",
      "ru": "Что можно улучшить - более здоровые способы приготовления, порции, замены"
    },
    "ingredients": {
      "en": ["ingredient1", "ingredient2"],
      "ru": ["ингредиент1", "ингредиент2"]
    },
    "recipe": {
      "en": "DETAILED step-by-step cooking instructions with prep time, " +
            "method, temperature, serving tips",
      "ru": "ПОДРОБНЫЕ пошаговые инструкции с временем подготовки, " +
            "способом приготовления, температурой, советами по подаче"
    },
    "healthy_alternatives": {
      "en": "Healthy ingredient swaps and substitutions",
      "ru": "Здоровые замены ингредиентов и альтернативы"
    },
    "meal_type": "full_meal|snack|drink",
    "difficulty": "very_easy|easy|medium",
    "prep_time_minutes": number,
    "is_comfort_food": boolean,
    "is_healthy_alternative": boolean
  }
]

RECIPE EXAMPLES:
- For meals: Include cooking steps, times, temperatures
- For snacks: Include preparation and serving suggestions  
- For drinks: Include mixing instructions and proportions

Focus on realistic, achievable meals that Americans actually eat.`;

  const messages: OpenAIMessage[] = [
    {
      role: "developer",
      content: [{type: "text", text: systemPrompt}],
    },
    {
      role: "user",
      content: [{type: "text", text: `Generate 3 meals for tag "${tagName}"`}],
    },
  ];

  try {
    const textModel = "gpt-5";
    const {text: responseText, usage} = await callOpenAI({
      model: textModel,
      messages,
      responseFormat: "json_object",
      reasoningEffort: "low",
    });
    if (usage) {
      console.log("🧮 Tokens:", {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
      });
    }
    console.log(`🤖 GPT ответ для ${tagName}:`, responseText.slice(0, 200));

    const meals = JSON.parse(responseText) as GeneratedMeal[];

    if (!Array.isArray(meals) || meals.length !== 3) {
      throw new Error(`Expected 3 meals, got ${meals?.length}`);
    }

    return meals;
  } catch (error) {
    console.error(`❌ Ошибка генерации для тега ${tagName}:`, error);
    throw error;
  }
}

/**
 * Save a meal to Firestore with generated photo.
 */
async function saveMealToFirestore(meal: GeneratedMeal): Promise<boolean> {
  console.log(`💾 Сохраняем блюдо: ${meal.title}`);

  try {
    // Генерируем фото
    const imageModel = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";
    const prompt =
      `Imagine a realistic photo of ${meal.title}. View from above. ` +
      "Morning soft natural light, warm and cozy kitchen ambience, " +
      "grey background. The food looks home-cooked with slight imperfections, " +
      "muted natural colors, and no artificial oversaturation. " +
      "It looks like a casual photo taken with a smartphone, not a professional studio. " +
      "The plating is slightly uneven with small crumbs or sauce drops, " +
      "making it feel authentic and homemade.";

    const {urls} = await callOpenAIImage({
      model: imageModel,
      prompt,
      size: "1024x1024",
    });

    const imageUrl = urls[0];
    if (!imageUrl) {
      throw new Error("Failed to generate image");
    }

    console.log(`📸 Изображение сгенерировано для ${meal.title}`);

    // Сжимаем и загружаем изображение
    const mealId = db.collection(COLLECTIONS.GENERATED_MEALS).doc().id;
    const {photoUrl, blurhash} = await compressAndUploadImage(
      imageUrl,
      bucket,
      mealId
    );

    // Создаем полный объект блюда с дополнительными полями
    const mealData: GeneratedMeal = {
      ...meal,
      photo: photoUrl,
      blurhash_photo: blurhash,
      created_time: admin.firestore.Timestamp.now(),
      language: "en", // По умолчанию, но теперь у нас есть локализация
    };

    // Сохраняем в Firestore
    await db.collection(COLLECTIONS.GENERATED_MEALS).doc(mealId).set(mealData);

    console.log(`✅ Блюдо ${meal.title} успешно сохранено с ID: ${mealId}`);
    return true;
  } catch (error) {
    console.error(`❌ Ошибка сохранения блюда ${meal.title}:`, error);
    return false;
  }
}

/**
 * Generate and save meals for one unprocessed tag.
 */
export async function generateMealsForOneTag(): Promise<void> {
  console.log("🚀 Поиск тега для генерации блюд...");

  try {
    // Находим первый тег, который еще не обработан
    const tagsSnap = await db
      .collection(COLLECTIONS.TAGS)
      .where("isGenerated", "!=", true)
      .limit(1)
      .get();

    if (tagsSnap.empty) {
      console.log("✅ Все теги уже обработаны!");
      return;
    }

    const tagDoc = tagsSnap.docs[0];
    const tagData = tagDoc.data();
    const tagName = tagData.name;

    console.log(`🎯 Обрабатываем тег: ${tagName}`);

    // Генерируем блюда для этого тега
    let meals: GeneratedMeal[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        meals = await generateMealsForTag(tagName);
        break;
      } catch (error) {
        console.error(`❌ Попытка ${attempt} генерации провалилась:`, error);
        if (attempt === 3) throw error;
      }
    }

    // Сохраняем каждое блюдо
    let savedCount = 0;
    for (const meal of meals) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const success = await saveMealToFirestore(meal);
          if (success) {
            savedCount++;
            break;
          }
        } catch (error) {
          console.error(`❌ Попытка ${attempt} сохранения блюда ${meal.title} провалилась:`, error);
          if (attempt === 3) throw error;
        }
      }
    }

    console.log(`✅ Успешно сгенерировано и сохранено ${savedCount} блюд для тега ${tagName}`);

    // Обновляем тег как обработанный
    await db.collection(COLLECTIONS.TAGS).doc(tagDoc.id).update({
      isGenerated: true,
      updated_time: admin.firestore.Timestamp.now(),
    });

    console.log(`✅ Тег ${tagName} отмечен как обработанный`);
  } catch (error) {
    console.error("❌ Ошибка в процессе генерации блюд для тега:", error);
  }
}

