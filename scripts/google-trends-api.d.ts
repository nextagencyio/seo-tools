declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string | string[]
    startTime?: Date
    endTime?: Date
    geo?: string
    hl?: string
    category?: number
    property?: string
  }

  function interestOverTime(options: TrendsOptions): Promise<string>
  function relatedQueries(options: TrendsOptions): Promise<string>
  function relatedTopics(options: TrendsOptions): Promise<string>
  function interestByRegion(options: TrendsOptions): Promise<string>

  export default {
    interestOverTime,
    relatedQueries,
    relatedTopics,
    interestByRegion,
  }
}
