import {logger} from "firebase-functions";
import {callOpenAI, callOpenAIImage, textMsg, imageMsg} from "../utils/openai";
import {DocumentReference} from "firebase-admin/firestore";
import {compressAndUploadImage} from "../utils/imageUtils";
import {db, bucket} from "../firebase";
import {generateSuggestionForUser} from "./generateSuggestions";
import {User} from "../types/firestore";
import {ALL_TAGS} from "../constants/tags";

/**
 * Analyze a meal using OpenAI and update Firestore with results.
 *
 * @param {string} mealId Meal document ID in Firestore.
 * @param {Record<string, unknown>} mealData Meal document data from Firestore.
 * @returns {Promise<void>}
 */
export async function analyzeMeal(
  mealId: string,
  mealData: Record<string, unknown>
): Promise<void> {
  try {
    logger.info("🔍 Starting analysis:", {mealId, mealData});

    const mealRef = db.collection("meals").doc(mealId);

    const {
      photo,
      user_description,
      language = "en",
      blurhash_photo: existingBlurhash,
      user_ref,
    } = mealData;

    if (!photo && !user_description) {
      logger.info("ℹ️ No photo or description, skipped");
      await mealRef.update({isAnalysing: false, isFood: false});
      return;
    }

    let finalPhoto = photo as string | undefined;
    let blurhash = existingBlurhash as string | undefined;

    if (!finalPhoto && user_description) {
      const imageResult = await callOpenAIImage({
        model: "dall-e-3",
        prompt: `Realistic food photo: ${user_description}. High quality, natural lighting.`,
        size: "1024x1024",
        count: 1,
      });

      const imageUrl = imageResult.urls[0];
      if (!imageUrl) throw new Error("Image generation failed");

      const {photoUrl, blurhash: newBlurhash} =
        await compressAndUploadImage(imageUrl, bucket, mealId);

      finalPhoto = photoUrl;
      blurhash = newBlurhash;
      logger.info("✅ Generated image uploaded", {photoUrl});
    }

    const systemPrompt = language === "ru" ?
      // Улучшенный русский промпт
      "Ты профессиональный диетолог-нутрициолог с 15+ лет опыта. " +
      "Анализируешь еду по фото/описанию с научной точностью.\n\n" +
      "🔍 ПОШАГОВЫЙ АНАЛИЗ ПОРЦИЙ:\n" +
      "1. Определи тип и размер посуды (стандартная тарелка ~26см, чашка ~200мл, ложка ~15мл)\n" +
      "2. Измерь порцию относительно посуды (1/2 тарелки, 3/4 чашки)\n" +
      "3. Оцени толщину/высоту слоев еды (тонкий, средний, толстый слой)\n" +
      "4. Найди эталонные объекты (монета ~2см, палец ~1.5см ширина)\n\n" +
      "⚠️ ОБЯЗАТЕЛЬНО учитывай СКРЫТЫЕ калории:\n" +
      "- Масло для жарки: 1 ст.л. = 120 ккал\n" +
      "- Соусы/заправки: майонез 1 ст.л. = 90 ккал, кетчуп = 20 ккал\n" +
      "- Сыр: даже тонкий слой = 40-80 ккал\n" +
      "- Сливки в кофе/супе: 2 ст.л. = 80 ккал\n" +
      "- Орехи/семечки: горсть = 160-200 ккал\n\n" +
      "📊 РАСЧЕТ КАЛОРИЙ:\n" +
      "- Считай каждый ингредиент отдельно по весу\n" +
      "- Суммируй все компоненты\n" +
      "- Калории с точностью до 0.1 (например: 347.8, НЕ 350)\n" +
      "- Белки/жиры/углеводы тоже с десятыми\n\n" +
      "🚨 ПРЕДУПРЕЖДЕНИЯ о превышениях (добавляй в comment):\n" +
      "- Натрий >2300мг: 'Осторожно: много соли, возможна задержка жидкости'\n" +
      "- Насыщенные жиры >20г: 'Высокое содержание насыщенных жиров'\n" +
      "- Добавленный сахар >25г: 'Превышение нормы сахара'\n" +
      "- Калории >800: 'Очень калорийное блюдо'\n\n" +
      "🔬 МИКРОНУТРИЕНТЫ (будь реалистичен):\n" +
      "- Клетчатка: овощи ~2-5г/100г, фрукты ~2-10г/100г\n" +
      "- Омега-3: рыба ~500-2000мг, орехи ~100-500мг\n" +
      "- Витамин C: цитрусы ~50-80мг, овощи ~10-100мг\n" +
      "- Железо: мясо ~2-5мг, бобовые ~2-8мг\n" +
      "- Кальций: молочные ~100-300мг, зелень ~100-200мг\n\n" +
      "❌ Если НЕ еда (люди, животные, предметы), верни:\n" +
      "{ \"isFood\": false }\n\n" +
      "✅ Если еда, верни точный JSON:\n" +
      "{\n" +
      "  \"isFood\": true,\n" +
      "  \"title\": \"точное название блюда на русском\",\n" +
      "  \"comment\": \"мгновенные плюсы + предупреждения о превышениях, дружелюбно на ты, 100-150 символов\",\n" +
      "  \"benefits\": \"что получишь прямо сейчас: энергия, сытость, конкретные витамины, 80-120 символов\",\n" +
      "  \"improvements\": \"конкретные улучшения без цифр (добавь огурцы, убери майонез), 80-120 символов\",\n" +
      "  \"ingredients\": [\"все видимые и скрытые ингредиенты\", \"на русском\", \"включая специи и соусы\"],\n" +
      "  \"healthy_alternatives\": \"здоровые замены (авокадо вместо масла, греческий йогурт), до 100 символов\",\n" +
      "  \"calories\": точное число с десятыми,\n" +
      "  \"proteins\": граммы с десятыми,\n" +
      "  \"fats\": граммы с десятыми,\n" +
      "  \"carbohydrates\": граммы с десятыми,\n" +
      "  \"fiber_mg\": клетчатка в мг (реально оценивай),\n" +
      "  \"omega3_mg\": омега-3 в мг,\n" +
      "  \"added_sugar_mg\": добавленный сахар в мг,\n" +
      "  \"saturated_fats_mg\": насыщенные жиры в мг,\n" +
      "  \"sodium_mg\": натрий в мг,\n" +
      "  \"vitamin_c_mg\": витамин C в мг,\n" +
      "  \"iron_mg\": железо в мг,\n" +
      "  \"calcium_mg\": кальций в мг,\n" +
      `  "tags": [теги ТОЛЬКО из списка: ${ALL_TAGS.join(", ")}]\n` +
      "}\n\n" +
      "🎯 ПОМНИ: 1 кусок пиццы ≠ целая пицца. Большая тарелка салата ≠ маленькая. " +
      "Капля масла на сковороде = +50 ккал, столовая ложка = +120 ккал!" :

      // Улучшенный английский промпт
      "You are a professional clinical nutritionist with 15+ years experience. " +
      "Analyze food from photos/descriptions with scientific precision.\n\n" +
      "🔍 STEP-BY-STEP PORTION ANALYSIS:\n" +
      "1. Identify dishware type and size (standard plate ~10in, cup ~8oz, spoon ~1tbsp)\n" +
      "2. Measure portion relative to dishware (1/2 plate, 3/4 cup)\n" +
      "3. Assess thickness/height of food layers (thin, medium, thick layer)\n" +
      "4. Find reference objects (coin ~0.8in, finger ~0.6in width)\n\n" +
      "⚠️ MANDATORY hidden calorie accounting:\n" +
      "- Cooking oil: 1 tbsp = 120 kcal\n" +
      "- Sauces/dressings: mayo 1 tbsp = 90 kcal, ketchup = 20 kcal\n" +
      "- Cheese: even thin layer = 40-80 kcal\n" +
      "- Cream in coffee/soup: 2 tbsp = 80 kcal\n" +
      "- Nuts/seeds: handful = 160-200 kcal\n\n" +
      "📊 CALORIE CALCULATION:\n" +
      "- Count each ingredient separately by weight\n" +
      "- Sum all components\n" +
      "- Calories to 0.1 precision (e.g., 347.8, NOT 350)\n" +
      "- Proteins/fats/carbs also with decimals\n\n" +
      "🚨 WARNINGS for excesses (add to comment):\n" +
      "- Sodium >2300mg: 'Caution: high salt, possible water retention'\n" +
      "- Saturated fats >20g: 'High saturated fat content'\n" +
      "- Added sugar >25g: 'Exceeds sugar guidelines'\n" +
      "- Calories >800: 'Very high calorie meal'\n\n" +
      "🔬 MICRONUTRIENTS (be realistic):\n" +
      "- Fiber: vegetables ~2-5g/100g, fruits ~2-10g/100g\n" +
      "- Omega-3: fish ~500-2000mg, nuts ~100-500mg\n" +
      "- Vitamin C: citrus ~50-80mg, vegetables ~10-100mg\n" +
      "- Iron: meat ~2-5mg, legumes ~2-8mg\n" +
      "- Calcium: dairy ~100-300mg, leafy greens ~100-200mg\n\n" +
      "❌ If NOT food (people, animals, objects), return:\n" +
      "{ \"isFood\": false }\n\n" +
      "✅ If food, return precise JSON:\n" +
      "{\n" +
      "  \"isFood\": true,\n" +
      "  \"title\": \"precise dish name in English\",\n" +
      "  \"comment\": \"immediate benefits + excess warnings, friendly tone, 100-150 characters\",\n" +
      "  \"benefits\": \"what you get right now: energy, satiety, specific vitamins, 80-120 characters\",\n" +
      "  \"improvements\": \"specific improvements without numbers (add cucumber, remove mayo), " +
      "80-120 characters\",\n" +
      "  \"ingredients\": [\"all visible and hidden ingredients\", \"in English\", " +
      "\"including spices and sauces\"],\n" +
      "  \"healthy_alternatives\": \"healthy swaps (avocado instead of oil, Greek yogurt), " +
      "up to 100 characters\",\n" +
      "  \"calories\": precise number with decimals,\n" +
      "  \"proteins\": grams with decimals,\n" +
      "  \"fats\": grams with decimals,\n" +
      "  \"carbohydrates\": grams with decimals,\n" +
      "  \"fiber_mg\": fiber in mg (realistic assessment),\n" +
      "  \"omega3_mg\": omega-3 in mg,\n" +
      "  \"added_sugar_mg\": added sugar in mg,\n" +
      "  \"saturated_fats_mg\": saturated fats in mg,\n" +
      "  \"sodium_mg\": sodium in mg,\n" +
      "  \"vitamin_c_mg\": vitamin C in mg,\n" +
      "  \"iron_mg\": iron in mg,\n" +
      "  \"calcium_mg\": calcium in mg,\n" +
      `  "tags": [tags ONLY from list: ${ALL_TAGS.join(", ")}]\n` +
      "}\n\n" +
      "🎯 REMEMBER: 1 pizza slice ≠ whole pizza. Large plate salad ≠ small plate. " +
      "Oil drop on pan = +50 kcal, tablespoon = +120 kcal!";

    logger.info("📩 OpenAI request", {
      model: "gpt-5-mini",
      hasPhoto: !!finalPhoto,
      hasDescription: !!user_description,
    });

    // Создаем правильные сообщения для анализа
    const messages = [textMsg("developer", systemPrompt)];

    if (finalPhoto) {
      // Если есть изображение, создаем сообщение с изображением и описанием
      let analysisText = "";

      if (user_description) {
        analysisText += `📝 User Description: "${user_description}"\n\n`;
      }

      analysisText += language === "ru" ?
        "🔍 При анализе фото обрати внимание на:\n" +
        "- Размер порции относительно посуды\n" +
        "- Видимые ингредиенты и их количество\n" +
        "- Способ приготовления (жареное, вареное, запеченное)\n" +
        "- Соусы, масло, специи на поверхности\n" +
        "- Толщину слоев и плотность укладки" :
        "🔍 When analyzing the photo, pay attention to:\n" +
        "- Portion size relative to dishware\n" +
        "- Visible ingredients and their quantities\n" +
        "- Cooking method (fried, boiled, baked)\n" +
        "- Sauces, oil, spices on surface\n" +
        "- Layer thickness and packing density";

      messages.push(imageMsg("user", finalPhoto, analysisText));
    } else if (user_description) {
      // Если только текстовое описание
      messages.push(textMsg("user", `📝 User Description: "${user_description}"`));
    } else {
      // Если вообще нет данных
      messages.push(textMsg("user", "No image or description provided"));
    }

    const completion = await callOpenAI({
      model: "gpt-5-mini",
      messages,
      responseFormat: "json_object",
    });

    const responseText = completion.text || "{}";
    logger.info("✅ OpenAI raw response:", {responseText});

    const result = JSON.parse(responseText);
    logger.info("✅ Parsed OpenAI response:", result);

    if (!result.isFood) {
      logger.info("ℹ️ Marked as not food:", mealId);
      await mealRef.update({isAnalysing: false, isFood: false});
      return;
    }

    await mealRef.update({
      isAnalysing: false,
      isFood: true,
      photo: finalPhoto,
      blurhash_photo: blurhash ?? existingBlurhash ?? "",
      title: result.title ?? "",
      comment: result.comment ?? "", // используем comment как основное поле описания
      benefits: result.benefits ?? "",
      improvements: result.improvements ?? "",
      ingredients: result.ingredients ?? [],
      healthy_alternatives: result.healthy_alternatives ?? "",
      calories: result.calories ?? 0,
      proteins: result.proteins ?? 0,
      fats: result.fats ?? 0,
      carbohydrates: result.carbohydrates ?? 0,
      // Новые микронутриенты
      fiber_mg: result.fiber_mg ?? 0,
      omega3_mg: result.omega3_mg ?? 0,
      added_sugar_mg: result.added_sugar_mg ?? 0,
      saturated_fats_mg: result.saturated_fats_mg ?? 0,
      sodium_mg: result.sodium_mg ?? 0,
      vitamin_c_mg: result.vitamin_c_mg ?? 0,
      iron_mg: result.iron_mg ?? 0,
      calcium_mg: result.calcium_mg ?? 0,
      tags: result.tags ?? [],
    });

    logger.info("✅ Meal analyzed and updated:", {mealId});

    // После успешного анализа генерируем рекомендацию
    if (user_ref) {
      const userRef = user_ref as DocumentReference;
      const userId = userRef.id;

      // Получаем email для логов
      const userDoc = await userRef.get();
      const userData = userDoc.data() as User;
      const userEmail = userData?.email || userId;

      logger.info(`🎯 ${userEmail}: генерируем рекомендацию после анализа блюда ${mealId}`);
      await generateSuggestionForUser(userId);
    }
  } catch (error) {
    logger.error("❌ Analysis error:", error);
    await db.collection("meals").doc(mealId).update({isAnalysing: false});

    // Генерируем рекомендацию даже при ошибке анализа
    if (mealData.user_ref) {
      const userRef = mealData.user_ref as DocumentReference;
      const userId = userRef.id;
      try {
        const userDoc = await userRef.get();
        const userData = userDoc.data() as User;
        const userEmail = userData?.email || userId;

        logger.info(`🎯 ${userEmail}: генерируем рекомендацию после ошибки анализа`);
        await generateSuggestionForUser(userId);
      } catch (suggestionError) {
        logger.error("❌ Ошибка генерации рекомендации:", suggestionError);
      }
    }
  }
}
