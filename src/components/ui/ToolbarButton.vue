<script setup>
defineProps({
  icon: { type: String, default: '' },
  label: { type: String, default: '' },
  active: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
});
</script>

<template>
  <button :type="type" class="bt-toolbar-button" :class="{ active }">
    <span v-if="icon" class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
    <span v-if="label">{{ label }}</span>
    <slot />
  </button>
</template>
