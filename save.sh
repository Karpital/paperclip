#!/bin/bash
# Сохранить изменения Paperclip на GitHub
cd /root/leadgeniy/paperclip

# Проверить что мы на правильной ветке
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "my-features" ]; then
    echo "Переключаюсь на my-features..."
    git checkout my-features
fi

# Проверить есть ли изменения
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo "Нет изменений для сохранения."
    exit 0
fi

# Показать что изменилось
echo "=== Изменённые файлы ==="
git status --short
echo ""

# Сохранить
MSG="${1:-update: paperclip customizations}"
git add -A
git commit -m "$MSG"
git push origin my-features --force-with-lease

echo ""
echo "Готово! Изменения сохранены на GitHub."
