<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

const navItems = [
  { href: '/statistics', key: 'nav_statistics', fallback: 'Statistics' },
  { href: '/infomobilita', key: 'nav_infomobilita', fallback: 'Infomobilita' },
  { href: '/about', key: 'nav_about', fallback: 'About' },
];

const languageOptions = [
  { value: 'zh', label: 'Chinese', short: 'CN' },
  { value: 'en', label: 'English', short: 'EN' },
  { value: 'it', label: 'Italiano', short: 'IT' },
];

const themeOptions = [
  { value: 'auto', key: 'theme_auto', icon: 'contrast', fallback: 'System' },
  { value: 'light', key: 'theme_light', icon: 'light_mode', fallback: 'Light' },
  { value: 'dark', key: 'theme_dark', icon: 'dark_mode', fallback: 'Dark' },
];

const fallbackText = {
  zh: {
    nav_statistics: '统计',
    nav_infomobilita: '出行信息',
    nav_about: '关于',
    theme_auto: '跟随系统',
    theme_light: '浅色模式',
    theme_dark: '深色模式',
    nav_menu: '菜单',
    nav_language: '语言',
    nav_theme: '主题',
  },
  en: {
    nav_statistics: 'Statistics',
    nav_infomobilita: 'Travel info',
    nav_about: 'About',
    theme_auto: 'System',
    theme_light: 'Light',
    theme_dark: 'Dark',
    nav_menu: 'Menu',
    nav_language: 'Language',
    nav_theme: 'Theme',
  },
  it: {
    nav_statistics: 'Statistiche',
    nav_infomobilita: 'Infomobilita',
    nav_about: 'Info',
    theme_auto: 'Sistema',
    theme_light: 'Chiaro',
    theme_dark: 'Scuro',
    nav_menu: 'Menu',
    nav_language: 'Lingua',
    nav_theme: 'Tema',
  },
};

const currentLang = ref('zh');
const currentTheme = ref('auto');
const menuOpen = ref(false);
const pathname = ref('/');
const navRef = ref(null);

const activeThemeIcon = computed(() => {
  const option = themeOptions.find((item) => item.value === currentTheme.value);
  return option?.icon || 'contrast';
});

function tr(key, fallback = '') {
  if (typeof window !== 'undefined') {
    const value = window.translations?.[currentLang.value]?.[key];
    if (value) return value;
  }
  return fallbackText[currentLang.value]?.[key] || fallbackText.en[key] || fallback;
}

function syncState() {
  if (typeof window === 'undefined') return;
  currentLang.value = window.currentLang || localStorage.getItem('language') || 'zh';
  currentTheme.value = window.currentTheme || localStorage.getItem('theme') || 'auto';
  pathname.value = window.location.pathname || '/';
}

function changeLanguage(lang) {
  if (typeof window !== 'undefined' && typeof window.changeLang === 'function') {
    window.changeLang(lang);
  }
  currentLang.value = lang;
  menuOpen.value = false;
}

function changeThemeValue(theme) {
  if (typeof window !== 'undefined' && typeof window.changeTheme === 'function') {
    window.changeTheme(theme);
  }
  currentTheme.value = theme;
  menuOpen.value = false;
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function handleDocumentPointerDown(event) {
  if (!menuOpen.value || !navRef.value) return;
  if (!navRef.value.contains(event.target)) {
    menuOpen.value = false;
  }
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape') {
    menuOpen.value = false;
  }
}

function isActive(href) {
  if (href === '/') return pathname.value === '/';
  return pathname.value.startsWith(href);
}

onMounted(() => {
  syncState();
  window.addEventListener('bellotreno:language-change', syncState);
  window.addEventListener('bellotreno:theme-change', syncState);
  document.addEventListener('astro:page-load', syncState);
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
});

onUnmounted(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener('bellotreno:language-change', syncState);
  window.removeEventListener('bellotreno:theme-change', syncState);
  document.removeEventListener('astro:page-load', syncState);
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
});
</script>

<template>
  <nav
    ref="navRef"
    class="bt-site-nav"
    aria-label="BelloTreno"
  >
    <a href="/" class="bt-brand" aria-label="BelloTreno home">
      <span>Bello</span><span>Treno</span>
    </a>

    <div class="bt-nav-desktop" aria-label="Primary navigation">
      <Button
        v-for="item in navItems"
        :key="item.href"
        as="a"
        :href="item.href"
        variant="ghost"
        size="sm"
        class="bt-nav-link"
        :class="{ 'bt-nav-link-active': isActive(item.href) }"
      >
        {{ tr(item.key, item.fallback) }}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="sm" class="bt-icon-button" :aria-label="tr('nav_language', 'Language')">
            <span class="material-symbols-outlined">language</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="bt-menu-content" :side-offset="10" align="end">
          <DropdownMenuItem
            v-for="item in languageOptions"
            :key="item.value"
            class="bt-menu-item"
            :class="{ 'bt-menu-item-active': item.value === currentLang }"
            @select="changeLanguage(item.value)"
          >
            {{ item.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" class="bt-icon-button" :aria-label="tr('nav_theme', 'Theme')">
            <span class="material-symbols-outlined">{{ activeThemeIcon }}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="bt-menu-content" :side-offset="10" align="end">
          <DropdownMenuItem
            v-for="item in themeOptions"
            :key="item.value"
            class="bt-menu-item"
            :class="{ 'bt-menu-item-active': item.value === currentTheme }"
            @select="changeThemeValue(item.value)"
          >
            <span class="material-symbols-outlined">{{ item.icon }}</span>
            <span>{{ tr(item.key, item.fallback) }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="bt-nav-mobile">
      <Button
        variant="ghost"
        size="icon-sm"
        class="bt-icon-button"
        :aria-label="tr('nav_menu', 'Menu')"
        :aria-expanded="menuOpen"
        aria-controls="bt-mobile-menu"
        @click="toggleMenu"
      >
        <span class="material-symbols-outlined">{{ menuOpen ? 'close' : 'menu' }}</span>
      </Button>

      <div v-if="menuOpen" id="bt-mobile-menu" class="bt-mobile-panel" role="menu">
        <nav class="bt-mobile-panel-nav" aria-label="Mobile navigation">
          <a
            v-for="item in navItems"
            :key="item.href"
            :href="item.href"
            class="bt-mobile-link"
            :class="{ 'bt-nav-link-active': isActive(item.href) }"
            role="menuitem"
            @click="menuOpen = false"
          >
            {{ tr(item.key, item.fallback) }}
          </a>
        </nav>

        <div class="bt-mobile-group">
          <span>{{ tr('nav_language', 'Language') }}</span>
          <div class="bt-mobile-switcher">
            <Button
              v-for="item in languageOptions"
              :key="item.value"
              type="button"
              variant="outline"
              size="sm"
              :class="{ active: item.value === currentLang }"
              @click="changeLanguage(item.value)"
            >
              {{ item.short }}
            </Button>
          </div>
        </div>

        <div class="bt-mobile-group">
          <span>{{ tr('nav_theme', 'Theme') }}</span>
          <div class="bt-mobile-switcher">
            <Button
              v-for="item in themeOptions"
              :key="item.value"
              type="button"
              variant="outline"
              size="sm"
              :class="{ active: item.value === currentTheme }"
              @click="changeThemeValue(item.value)"
            >
              <span class="material-symbols-outlined">{{ item.icon }}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  </nav>
</template>
