<script setup>
import { Button } from '@/components/ui/button';

defineProps({
  icon: { type: String, default: '' },
  label: { type: String, default: '' },
  active: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
});
</script>

<template>
  <Button
    :type="type"
    :variant="active ? 'default' : 'ghost'"
    size="sm"
    class="bt-toolbar-button"
    :class="{ active }"
  >
    <span v-if="icon" class="material-symbols-outlined" aria-hidden="true">{{ icon }}</span>
    <span v-if="label">{{ label }}</span>
    <slot />
  </Button>
</template>
