# 基础模板目录

```json evaldock-dataset-catalog
{
  "schema": "evaldock.dataset-planner-catalog/v1",
  "version": "1.0",
  "datasets": [
    {
      "datasetId": "dataset.basic-file-delivery/v1",
      "name": "基础文件交付模板",
      "description": "仅含一道读取 JSON、计算并写入结果的基础题，用于验证输入投递、执行采集、交付物与 Judge 链路，不用于能力排名。",
      "labelIds": [
        "label.artifact-delivery/v1",
        "label.efficiency-cost/v1"
      ],
      "availableCaseCount": 1,
      "estimatedSecondsPerCase": 120
    }
  ]
}
```
