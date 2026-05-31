<script setup>
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, required: true },
  ariaLabel: { type: String, default: 'Segmented control' },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <Tabs
    class="bt-segmented"
    :model-value="modelValue"
    :aria-label="ariaLabel"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <TabsList class="bt-segmented-list">
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
  </Tabs>
</template>
