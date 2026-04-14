import React, { FC } from "react"
import { useTranslation } from "react-i18next"
import { breakableString, formatSize } from "../../util"
import { Progress } from "../../modules/download"
import { PrograssBar } from "./ProgressBar"
import { SyncProgressList } from "./SyncProgressList"

/**
 * This component is what is shown while there is a download in progress.
 * Shows progress bars with download percentage and path of the files being downloaded
 */
export const SyncProgressWrap: FC<{ progress: Progress }> = props => {
  const { t } = useTranslation("client", { keyPrefix: "syncProgress" })

  const { progress } = props

  const fdown = progress?.files?.[0]?.downloaded ?? 0
  const ftot = progress?.files?.[0]?.total ?? 0

  const filePercentage = fdown / ftot
  const percentage = progress?.downloaded / progress?.total

  return (
    <div className="sync-progress-wrap">
      {progress?.files?.length > 1 ? (
        <SyncProgressList files={progress.files} />
      ) : undefined}

      <div>
        <div className="progress-container">
          <div className="fileinfo">
            <span className="filename">{progress.files[0].filename}</span>
            <span className="filepath">
              {breakableString(progress.files[0].absolutePath)}
            </span>
          </div>
          <span className="right">
            {/* Show '??' if file size is unknown, lazily resolved during download */}
            {ftot > 0
              ? `${formatSize(fdown)} / ${formatSize(ftot)} (${Math.floor(filePercentage * 100)}%)`
              : `${formatSize(fdown)} / ??`}
          </span>
        </div>
        {ftot > 0 && <PrograssBar progress={filePercentage} />}
      </div>

      {/* Only show total bar once the aggregate size is known (may result in a delay on unknown-size files) */}
      {progress.total > 0 && (
        <div>
          <h3>{t("total")}</h3>
          <span className="right">
            {`${formatSize(progress.downloaded)} / ${formatSize(progress.total)} (${Math.floor(percentage * 100)}%)`}
          </span>
          <PrograssBar progress={percentage} />
        </div>
      )}
    </div>
  )
}
