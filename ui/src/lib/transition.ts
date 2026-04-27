import { writable } from 'svelte/store'
import type { FrontPage } from './api'

export interface MorphSnapshot {
  topicId: number
  title: string
  summary: string
}

export const morphingTopicId = writable<number | null>(null)
export const morphSnapshot = writable<MorphSnapshot | null>(null)
export const frontPageCache = writable<FrontPage | null>(null)
