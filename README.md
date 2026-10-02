# pastebinX

Каталог вариантов кода на Next.js / TypeScript / PostgreSQL / Drizzle / Tailwind. `/` возвращает HTTP 404, `/defN` — страницу одной функции. На ней гармошка пользователей: раскрытие имени показывает его вариант кода. Пользователей без доступного варианта этой функции нет в списке. Просмотр открыт без входа; админка защищена одним общим паролем. Пользователи — имена авторов, без учётных записей и паролей.

## Развёртывание на VDS

Команды ниже рассчитаны на Ubuntu 24.04 с доступом sudo. Нужен домен с A-записью на IP VDS; если есть AAAA-запись, IPv6 также должен вести на сервер. Откройте входящие TCP 80 и 443 в панели VDS/файрволе. Для другой ОС установите Docker по соответствующей официальной инструкции.

### 1. Docker (если ещё не установлен)

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```

### 2. Клонирование и конфигурация

Замените `paste.example.com` своим доменом. Для приватного GitHub-репозитория используйте SSH deploy key с доступом только на чтение или авторизованный HTTPS clone.

```bash
git clone https://github.com/vertichooook/pastebinX.git
cd pastebinX
bash scripts/configure-env.sh https://paste.example.com
```

Скрипт создаёт `.env` с правами 600, случайными паролями и `ADMIN_PATH`, выводит адрес админки и пароль администратора. Сохраните их. Скрипт не перезаписывает существующий `.env`. Если Nginx уже проксирует домен, проверьте, что он **заменяет** X-Forwarded-For, прежде чем оставлять TRUST_PROXY=true.

### 3. Запуск контейнеров

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100 app
curl -i http://127.0.0.1:3000/
```

Ожидаемый ответ корня — **404 Not Found**, это нормальное поведение. При старте автоматически применяются SQL-миграции и создаётся администратор. Данные PostgreSQL остаются в named volume. База не доступна снаружи; приложение слушает порт 3000 только на loopback VDS. На сервере не нужны Node.js, pnpm или отдельная установка PostgreSQL.

### 4. HTTPS через Nginx

Если для домена уже есть reverse proxy с HTTPS, направьте его на `127.0.0.1:3000`, отключите кэш и задайте лимит тела запроса 8 МБ. Иначе:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pastebinX
sudo sed -i 's/paste\.example\.com/ВАШ.ДОМЕН/g' /etc/nginx/sites-available/pastebinX
sudo ln -s /etc/nginx/sites-available/pastebinX /etc/nginx/sites-enabled/pastebinX
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d ВАШ.ДОМЕН --redirect
sudo certbot renew --dry-run
```

В двух командах выше замените `ВАШ.ДОМЕН` на реальный домен. APP_URL в `.env` должен точно совпадать с HTTPS-адресом (без пути). HTTPS обязателен: production cookie имеет Secure. Не подключайте CDN-кэш к страницам и API.

### 5. Использование

Откройте адрес админки, напечатанный configure-env.sh, и введите общий пароль (логина нет). Добавьте имена пользователей, создайте функцию и добавьте ей варианты кода выбранных пользователей. Ссылка `/defN` общая для этой функции и доступна без авторизации.

Посетитель раскрывает нужное имя в гармошке и копирует код. Пользователи без варианта, скрытые пользователи, отключённые и истёкшие варианты не попадают ни в HTML, ни в публичный API. Отключённая или удалённая функция возвращает 404. Номера функций глобальные, после удаления не переиспользуются. Срок действия вводится в UTC.

### Обновление с предыдущей версии

Сначала сделайте backup базы. Автоматическая миграция объединяет прежние записи с одинаковым `defN` в функцию и сохраняет их как варианты разных пользователей. Название берётся из самого раннего текста этого номера; его можно изменить в админке. Пользовательские пароли удаляются, сессии отзываются; существующий пароль администратора сохраняется. После обновления активные варианты становятся доступны без входа. Переменная ADMIN_USERNAME больше не используется.

## Обновление, резервные копии, обслуживание

```bash
git pull --ff-only
sudo docker compose up -d --build
sudo docker compose logs --tail=100 app
```

Backup содержит секретные записи — храните его в защищённом месте:

```bash
umask 077
sudo docker compose exec -T db pg_dump -U paste -d paste -Fc > "backup-$(date +%F-%H%M%S).dump"
```

Восстановление в существующую базу (заменяет данные):

```bash
sudo docker compose stop app
sudo docker compose exec -T db pg_restore -U paste -d paste --clean --if-exists < backup.dump
sudo docker compose start app
```

`docker compose down` сохраняет данные; `docker compose down -v` удаляет базу. Seed создаёт администратора только при отсутствии: изменение ADMIN_PASSWORD в `.env` не сбрасывает его существующий пароль. Для смены общего пароля администратора используйте maintenance script:

```bash
sudo docker compose exec app pnpm admin:password
```

Введите новый пароль в интерактивном запросе (ввод скрыт). Скрипт отзывает сессии администратора. Затем обновите ADMIN_PASSWORD в `.env` для согласованности будущего восстановления с нуля.

Периодически удаляйте истёкшие служебные записи (тексты и аудит не затрагиваются):

```bash
sudo docker compose exec app pnpm db:cleanup
```

## Локальная разработка и проверки

Node.js 24, pnpm 11.19.0 и PostgreSQL 17. Создайте `.env` из `.env.example`; для разработки APP_URL=http://localhost:3000 и TRUST_PROXY=false. Команды используют dotenv через tsx/Next (Next читает `.env` автоматически; CLI scripts запускаются с `--env-file-if-exists=.env`).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

```bash
pnpm typecheck
pnpm build
pnpm test
```

Тесты запускают временный PostgreSQL 17 и production Next.js на портах 5497/3197. Проверяют перенос старых записей, удаление учётных записей, сохранение пароля админки, публичную гармошку, скрытие отсутствующих вариантов, CRUD, CSRF, XSS, конкурентную глобальную нумерацию, expiry, logout и лимит входа. CI проверяет сборку и запуск Docker Compose с автоматической миграцией и seed.

Для окружения без нативного PostgreSQL можно запустить те же HTTP-сценарии с `PASTE_TEST_PGLITE=true`; CI всегда использует нативный PostgreSQL 17.

Подробная схема: [docs/architecture.md](docs/architecture.md).

Официальные инструкции: [Docker Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [Certbot](https://certbot.eff.org/instructions?ws=nginx&os=pip).
