const coordinate = (value, limit) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
export function attendanceLocation(location, shopLatitude, shopLongitude) {
  if (!location || !coordinate(location.latitude,90) || !coordinate(location.longitude,180)) return null;
  let distanceMeters = typeof location.distanceMeters === 'number' && Number.isFinite(location.distanceMeters) && location.distanceMeters >= 0 ? location.distanceMeters : null;
  if(distanceMeters === null) {
    const lat = coordinate(location.shopLatitude,90) ? location.shopLatitude : shopLatitude == null ? null : Number(shopLatitude);
    const lon = coordinate(location.shopLongitude,180) ? location.shopLongitude : shopLongitude == null ? null : Number(shopLongitude);
    if(coordinate(lat,90) && coordinate(lon,180)) {
      const rad=value=>value*Math.PI/180;
      const h=Math.sin(rad(lat-location.latitude)/2)**2+Math.cos(rad(location.latitude))*Math.cos(rad(lat))*Math.sin(rad(lon-location.longitude)/2)**2;
      distanceMeters=6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
    }
  }
  return {latitude:location.latitude,longitude:location.longitude,distanceMeters,accuracyMeters:typeof location.accuracyMeters==='number'&&Number.isFinite(location.accuracyMeters)&&location.accuracyMeters>=0?location.accuracyMeters:null,capturedAt:location.capturedAt||null};
}
