import { z } from "zod";

/**
 * Общая схема маршрутизации для главной модели и каталога Max/Mini. Одна схема на два маршрута,
 * чтобы `fixed` без списка или `allowFallback` со списком из одного элемента не принимались в
 * одном месте и отвергались в другом.
 */
export const upstreamRoutingSchema = z.object({
  mode: z.enum(["auto", "fixed", "cheapest"]),
  providers: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  allowFallback: z.boolean().optional(),
  fallbackToAuto: z.boolean().optional(),
  assumedInputPerOutput: z.number().finite().min(1).max(100).optional(),
  maxPrice: z.object({
    prompt: z.number().finite().min(0).max(1_000_000).optional(),
    completion: z.number().finite().min(0).max(1_000_000).optional(),
  }).partial().optional(),
}).nullable().optional();
