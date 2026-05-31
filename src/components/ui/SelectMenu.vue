<script setup>
import {
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui';

defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, required: true },
  placeholder: { type: String, default: 'Select' },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <SelectRoot :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <SelectTrigger class="bt-select-trigger" :aria-label="placeholder">
      <SelectValue :placeholder="placeholder" />
      <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="bt-select-content" :side-offset="8">
        <SelectViewport>
          <SelectItem
            v-for="item in items"
            :key="item.value"
            class="bt-select-item"
            :value="item.value"
          >
            <SelectItemText>{{ item.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
