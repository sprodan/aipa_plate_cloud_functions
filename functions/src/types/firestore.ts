import {Timestamp, DocumentReference} from "firebase-admin/firestore";
import {AllTag} from "../constants/tags"; // Импортируем типы тегов

/**
 * Названия коллекций в Firestore
 */
export const COLLECTIONS = {
  USERS: "users",
  MEALS: "meals",
  GENERATED_MEALS: "generated_meals",
  FF_PUSH_NOTIFICATIONS: "ff_push_notifications",
  USER_TAG_STATISTICS: "user_tag_statistics",
  USER_GENERATED_MEAL_FEEDBACK: "user_generated_meal_feedback",
  TAGS: "tags",
  FCM_TOKENS: "fcm_tokens", // Добавили новую коллекцию
} as const;

/**
 * Интерфейс блюда
 */
export interface Meal {
  title: string;
  calories: number;
  proteins: number;
  fats: number;
  carbohydrates: number;
  tags: string[];
  created_time: Timestamp;
  photo?: string;
  blurhash_photo?: string;
  comment?: string;
  language: "en" | "ru";
  isFood: boolean;
  isAnalyzing: boolean;
  user_ref: DocumentReference;
  user_description?: string;
  meal_type?: "breakfast" | "lunch" | "dinner" | "snack";

  // Новые поля для детального анализа
  benefits?: string;
  improvements?: string;
  ingredients?: string[];
  healthy_alternatives?: string;

  // Микронутриенты в миллиграммах
  fiber_mg?: number;
  omega3_mg?: number;
  added_sugar_mg?: number;
  saturated_fats_mg?: number;
  sodium_mg?: number;
  vitamin_c_mg?: number;
  iron_mg?: number;
  calcium_mg?: number;
}

/**
 * Интерфейс сгенерированного блюда
 */
export interface GeneratedMeal {
  // Старые поля (не трогаем для обратной совместимости)
  title: string;
  user_description?: string;
  calories: number;
  proteins: number;
  fats: number;
  carbohydrates: number;
  tags: AllTag[]; // Используем типизированные теги
  created_time: Timestamp;
  photo?: string;
  blurhash_photo?: string;
  comment: string; // старое описание
  language: "en" | "ru";

  // НОВЫЕ поля с мультиязычностью
  title_localized?: {
    en: string; // max 35 символов
    ru: string; // max 35 символов
  };

  description_localized?: {
    en: string;
    ru: string;
  };

  benefits?: {
    en: string; // что хорошего в этой еде
    ru: string;
  };

  improvements?: {
    en: string; // что можно улучшить
    ru: string;
  };

  ingredients?: {
    en: string[]; // массив ингредиентов
    ru: string[];
  };

  recipe?: {
    en: string; // рецепт приготовления
    ru: string;
  };

  healthy_alternatives?: {
    en: string; // здоровые замены ингредиентов
    ru: string;
  };

  // Мета-информация
  meal_type?: "full_meal" | "snack" | "drink"; // тип блюда
  difficulty?: "very_easy" | "easy" | "medium"; // сложность приготовления
  prep_time_minutes?: number; // время приготовления в минутах
  is_comfort_food?: boolean; // популярное американское блюдо
  is_healthy_alternative?: boolean; // здоровая альтернатива
}

/**
 * Интерфейс тега
 */
export interface Tag {
  name: string;
  bg_color: string;
  text_color: string;
  group: string;
  isGenerated: boolean;
  labels: {
    en: string;
    ru: string;
  };
  created_time?: Timestamp; // Добавляем опциональные поля для новых тегов
  updated_time?: Timestamp;
}

/**
 * Интерфейс статистики тегов пользователя
 */
export interface UserTagStatistics {
  user_ref: DocumentReference;
  tag_ref: DocumentReference;
  count: number;
}

/**
 * Интерфейс обратной связи по сгенерированному блюду
 */
export interface UserGeneratedMealFeedback {
  user_ref: DocumentReference;
  generated_meal_ref: DocumentReference;
  is_liked: boolean;
}

/**
 * Интерфейс пользователя
 */
export interface User {
  uid: string;
  email?: string;
  created_time: Timestamp;
  active_calories: number;
  passive_calories: number;
  height_cm?: number;
  height_system?: "cm" | "ft";
  height_imp_in?: number;
  height_imp_ft?: number;
  weight_lbs?: number;
  weight_kg?: number;
  weight_system?: "kg" | "lb";
  age?: number;
  display_name?: string;
  photo_url?: string;
  language?: "en" | "ru";
  meals: DocumentReference[];
  activity_1: number; // 1 - low, 2 - medium, 3 - high
  activity_2: number; // 1 - low, 2 - medium, 3 - high
  activity_3: number; // 1 - low, 2
  suggested_generated_meals: DocumentReference[];
  suggestion?: string;
  sex?: "male" | "female";
  fcm_tokens?: DocumentReference[];
  hoursOffset?: number; // Смещение часового пояса пользователя относительно UTC
}

/**
 * Интерфейс push-уведомления
 */
export interface FFPushNotification {
  title: string;
  body: string;
  created_time: Timestamp;
  user_ref: DocumentReference;
  data?: Record<string, string>;
}

/**
 * Интерфейс для FCM токенов
 */
export interface FcmToken {
  created_at: Timestamp;
  device_type: "iOS" | "Android";
  fcm_token: string;
}
