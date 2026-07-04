// Analytics consumer — subscribes to multiple event types to show fan-out.
// It doesn't change any state; it just records that the event happened. In a
// real system this might write to a data lake, Kinesis, or a metrics store.
exports.handler = async (event) => {
  const type = event["detail-type"];
  const detail = event.detail || {};
  console.log(
    `[analytics] ${type} orderId=${detail.orderId ?? "?"} at ${new Date().toISOString()}`,
    JSON.stringify(detail)
  );
};
