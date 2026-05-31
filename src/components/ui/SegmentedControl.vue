<script setup>
import { TabsIndicator, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';

defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, required: true },
  ariaLabel: { type: String, default: 'Segmented control' },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <TabsRoot
    class="bt-segmented"
    :model-value="modelValue"
    :aria-label="ariaLabel"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <TabsList class="bt-segmented-list">
      <TabsIndicator class="bt-segmented-indicator" />
      <TabsTrigger
        v-for="item in items"
        :key="item.value"
        class="bt-segmented-trigger"
        :value="item.value"
      >
        <span v-if="item.icon" class="material-symbols-outlined" aria-hidden="true">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </TabsTrigger>
    </TabsList>
  </TabsRoot>
</template>
