<script setup>
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, required: true },
  placeholder: { type: String, default: 'Select' },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <Select :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <SelectTrigger class="bt-select-trigger" :aria-label="placeholder">
      <SelectValue :placeholder="placeholder" />
    </SelectTrigger>
    <SelectContent class="bt-select-content" :side-offset="8">
      <SelectItem
        v-for="item in items"
        :key="item.value"
        class="bt-select-item"
        :value="item.value"
      >
        {{ item.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
