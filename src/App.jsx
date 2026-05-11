<div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
  <table className="w-full text-sm">
    <thead className="bg-neutral-100">
      <tr>
        <th className="px-4 py-3 text-left font-semibold text-neutral-600">
          姓名
        </th>

        <th className="px-4 py-3 text-left font-semibold text-neutral-600">
          部門
        </th>

        <th className="px-4 py-3 text-left font-semibold text-neutral-600">
          上班時間
        </th>

        <th className="px-4 py-3 text-left font-semibold text-neutral-600">
          下班時間
        </th>
      </tr>
    </thead>

    <tbody>
      <tr className="border-t border-neutral-200">
        <td className="px-4 py-3">
          {employee.name}
        </td>

        <td className="px-4 py-3">
          {record.department || "-"}
        </td>

        <td className="px-4 py-3">
          {record.clockIn || "-"}
        </td>

        <td className="px-4 py-3">
          {record.clockOut || "尚未下班"}
        </td>
      </tr>
    </tbody>
  </table>
</div>
