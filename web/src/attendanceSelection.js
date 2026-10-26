export function attendanceSelectionForDay(day, includeStaff = true) {
  return {shopIds:[day.shopCode],...(includeStaff?{workerIds:[day.workerCode]}:{}),fromDate:day.date,toDate:day.date};
}
