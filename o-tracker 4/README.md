# O Tracker

Telegram-бот + ассистент на Gemini + веб-дашборд для данных кольца Oura. Публичный многоязычный продукт (ru / en / pt, русский по умолчанию). Один бэкенд на Node.js + TypeScript обслуживает вебхук Telegram, OAuth Oura, API дашборда и планировщик ежедневной сводки.

> Независимый продукт, не связан с Ōura Health Oy.

## Архитектура

```
Telegram (webhook) ─┐
                    ├─▶ Backend (Fastify + grammY + node-cron) ─▶ Gemini API (Flash)
Веб-дашборд ────────┘            │
                                 ├─▶ Postgres (Prisma): users, oura_tokens(зашифр.), daily_metrics, gemini_usage_log
                                 └─▶ Oura API v2 (OAuth2)
```

## Стек

- **grammY** — Telegram-бот (режим webhook)
- **Fastify** + **@fastify/static** — веб-сервер, OAuth callback, API и статика дашборда
- **Prisma** + **Postgres** — данные и миграции
- **@google/genai** — ассистент Gemini (модель Flash)
- **node-cron** + **luxon** — планировщик сводки с учётом часовых поясов
- **zod** — валидация конфигурации

## Структура

```
src/
  config.ts            конфиг (валидируется zod при старте)
  index.ts             точка входа: бот + сервер + планировщик
  lib/                 db (Prisma), crypto (AES-256-GCM), users
  i18n/                ru/en/pt + t(lang, key, params)
  oura/                oauth, tokens (шифрование+refresh), client (API v2), sync
  gemini/              prompts, context (сборка контекста), assistant (2 режима, квота)
  bot/                 команды, онбординг, свободный текст → Gemini; summary
  server/              app (routes), telegramAuth, dashboardData
  scheduler/           ежедневная сводка по TZ + фоновая синхронизация
  dashboard/index.html одностраничный дашборд (navy-тема, ru/en/pt, тренды)
  legal/               privacy.html, terms.html
prisma/schema.prisma   схема БД
render.yaml            blueprint для деплоя на Render
```

## Предварительные требования

1. **Telegram-бот** — создайте у [@BotFather](https://t.me/BotFather), возьмите токен.
2. **Приложение Oura OAuth2** — зарегистрируйте на `https://cloud.ouraring.com/oauth/applications`.
   Redirect URI укажите как `https://ВАШ_ДОМЕН/oauth/oura/callback`. Возьмите client id/secret.
   ⚠️ Новое приложение ограничено **10 пользователями**, пока Oura не одобрит ревью — подайте заявку заранее.
3. **Gemini API key** — в Google AI Studio (бесплатный тариф; лимиты общие на весь проект — см. ТЗ, раздел 4.3).
4. **Postgres** — локально или управляемый (Render/Neon/Supabase).

## Локальный запуск

```bash
npm install
cp .env.example .env      # заполните значения (см. ниже про генерацию ключей)
npx prisma migrate dev    # создаст таблицы
npm run dev               # запуск с hot-reload (tsx)
```

Генерация секретов:

```bash
# ENCRYPTION_KEY (32 байта, base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# TELEGRAM_WEBHOOK_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Для локальной отладки вебхука Telegram нужен публичный HTTPS-URL — используйте `ngrok http 3000` и укажите его в `PUBLIC_URL`.

## Проверка сборки

```bash
npm run typecheck         # tsc --noEmit
npx prisma validate       # проверка схемы
npm run build             # сборка в dist/
```

## Деплой на Render

1. Запушьте репозиторий на GitHub.
2. В Render: **New → Blueprint**, выберите репозиторий (используется `render.yaml`).
3. Задайте секретные переменные (помечены `sync:false`): `PUBLIC_URL` (URL этого сервиса), `TELEGRAM_BOT_TOKEN`, `OURA_CLIENT_ID/SECRET`, `GEMINI_API_KEY`, `ENCRYPTION_KEY`.
4. В приложении Oura пропишите redirect URI `https://<render-url>/oauth/oura/callback`.
5. Вебхук Telegram выставляется автоматически при старте (см. `src/index.ts`).

Бесплатный тариф Render засыпает через 15 минут простоя (задержки в вебхуках) — для реальных пользователей включите **Starter (~$7/мес)**. Управляемый Postgres — от ~$6–7/мес.

## Как подключается аккаунт Oura (OAuth2)

Личные токены Oura отключены с декабря 2025 — используется authorization-code flow:

1. Пользователь пишет `/start` или `/connect` → бот создаёт одноразовый `state` (10 мин) и присылает ссылку на `/connect/oura?state=…`.
2. Сервер по `state` редиректит на страницу согласия Oura (`cloud.ouraring.com/oauth/authorize`).
3. Пользователь логинится в Oura и подтверждает доступ (пароль вводится только у Oura).
4. Oura редиректит на `/oauth/oura/callback?code&state` → сервер меняет `code` на токены, **шифрует** и сохраняет, делает первичную синхронизацию, бот пишет «Подключено ✅».
5. Токены обновляются автоматически перед истечением; отзыв — `/settings → Отключить` (удаляет токены и кэш).

Вход в дашборд — через **Telegram Login Widget** (без отдельных паролей).

## Режимы ассистента

- **По умолчанию — только по данным пользователя.** Контекст метрик за N дней внедряется в промпт; задача — не объяснить показатель, а дать конкретный выполнимый совет. Общие вопросы без данных не отвечаются молча.
- **Общие вопросы о здоровье — выключены по умолчанию**, включаются в `/settings`. Такие ответы помечаются «общая информация».

Дневная квота на пользователя (`GEMINI_DAILY_QUOTA_PER_USER`) защищает общий бесплатный лимит Gemini; при 429 бот отвечает мягко.

## Дальнейшие шаги (этап 2+)

- Подключить фронтенд дашборда к `GET /api/dashboard` (сейчас он работает на демо-данных `SAMPLE`).
- Синхронизация Oura через вебхуки вместо опроса.
- Еженедельный обзор, стрики/цели, голосовые сообщения, админ-панель.
- Подать приложение Oura на ревью для снятия лимита в 10 пользователей.
