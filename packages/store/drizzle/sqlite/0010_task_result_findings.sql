-- Task results now always carry a findings list. Give results stored before findings, or with
-- findings that are not a list, an empty list.
UPDATE `Task` SET `result` = json_set(`result`, '$.findings', json('[]'))
WHERE `result` IS NOT NULL AND json_type(`result`) = 'object' AND json_type(`result`, '$.findings') IS NOT 'array';--> statement-breakpoint
UPDATE `TaskAssignment` SET `result` = json_set(`result`, '$.taskResult.findings', json('[]'))
WHERE `result` IS NOT NULL AND json_type(`result`, '$.taskResult') = 'object'
  AND json_type(`result`, '$.taskResult.findings') IS NOT 'array';--> statement-breakpoint
UPDATE `Task` SET `sessionHistory` = (
  SELECT json_group_array(json(`entry`)) FROM (
    SELECT CASE
      WHEN json_type(e.`value`, '$.result') = 'object' AND json_type(e.`value`, '$.result.findings') IS NOT 'array'
        THEN json_set(e.`value`, '$.result.findings', json('[]'))
      ELSE e.`value`
    END AS `entry`
    FROM json_each(`Task`.`sessionHistory`) AS e ORDER BY e.`key`
  )
)
WHERE json_type(`sessionHistory`) = 'array' AND json_array_length(`sessionHistory`) > 0
  -- Stored history entries are objects; leave any other shape untouched rather than rewrite it.
  AND NOT EXISTS (SELECT 1 FROM json_each(`Task`.`sessionHistory`) WHERE `type` <> 'object');
