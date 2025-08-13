/**
 * Centralized tags configuration for the application
 */

export const NUTRITION_TAGS = [
  // Основные группы продуктов
  "vegetable", "fruit", "grain_whole", "grain_refined",
  "protein_meat_red", "protein_meat_white", "protein_fish",
  "protein_fish_fatty", "protein_egg", "protein_legumes",
  "protein_nuts", "dairy_lowfat", "dairy_highfat",

  // Макронутриенты и калории
  "high_protein", "high_fiber", "high_carb", "high_fat",
  "low_calorie", "high_calorie", "low_carb", "low_fat",

  // Здоровье и микронутриенты
  "gut_friendly", "high_omega_3", "high_iodine",
  "high_calcium", "high_magnesium", "high_iron",
  "high_vitamin_c", "high_vitamin_d", "high_zinc",
  "high_potassium", "high_folate", "high_selenium",
  "high_antioxidants",

  // Время приема пищи
  "breakfast", "lunch", "dinner", "snack",

  // Диетические ограничения
  "vegetarian", "vegan", "gluten_free", "kid_friendly",
  "low_salt", "no_added_sugar",

  // Приготовление и удобство
  "quick_easy", "seasonal",
] as const;

// НОВЫЕ теги для вкусовых предпочтений
export const TASTE_PREFERENCE_TAGS = [
  "no_fish", "no_seafood", "no_dairy", "no_nuts", "no_eggs",
  "no_spicy", "no_sweet", "no_bitter", "no_sour",
  "loves_chocolate", "loves_cheese", "loves_spicy",
] as const;

// НОВЫЕ теги для типов блюд
export const MEAL_TYPE_TAGS = [
  "quick_snack", "fruit_snack", "protein_snack", "veggie_snack",
  "comfort_food", "healthy_alternative", "traditional_american",
  "single_ingredient", // для простых перекусов типа банана
] as const;

// НОВЫЕ теги для времени и сложности
export const CONVENIENCE_TAGS = [
  "under_5_min", "under_10_min", "no_cooking_required",
  "beginner_friendly", "grab_and_go",
] as const;

// Объединенный массив всех тегов
export const ALL_TAGS = [
  ...NUTRITION_TAGS,
  ...TASTE_PREFERENCE_TAGS,
  ...MEAL_TYPE_TAGS,
  ...CONVENIENCE_TAGS,
] as const;

// Типы для TypeScript
export type NutritionTag = typeof NUTRITION_TAGS[number];
export type TastePreferenceTag = typeof TASTE_PREFERENCE_TAGS[number];
export type MealTypeTag = typeof MEAL_TYPE_TAGS[number];
export type ConvenienceTag = typeof CONVENIENCE_TAGS[number];
export type AllTag = typeof ALL_TAGS[number];
